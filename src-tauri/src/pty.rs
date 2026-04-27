//! PTY mux for RLI.
//!
//! Each session in the UI gets one PTY pair backed by `portable-pty`. The
//! master end is parked in `PtyState`; the slave is handed to the spawned
//! child (`zsh`, `claude`, `codex`, etc.). A dedicated thread reads bytes
//! from the master and forwards them to the frontend over Tauri events
//! (`pty://<id>/data`, `pty://<id>/exit`).
//!
//! Frontend writes go via the `pty_write` command. Resizes via `pty_resize`.
//! Cleanup via `pty_close`.
//!
//! Concurrency: `PtyState` is a `Mutex<HashMap>`. Operations are short and
//! happen at human speed (clicks, typing, resizes), so a single mutex is
//! plenty — no need for DashMap or lock-free trickery.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::Mutex;
use std::thread;

use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::Deserialize;
use tauri::{AppHandle, Emitter, Runtime, State};

#[derive(Default)]
pub struct PtyState {
    sessions: Mutex<HashMap<String, PtySession>>,
}

struct PtySession {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
}

#[derive(Debug, Deserialize)]
pub struct StartArgs {
    pub id: String,
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    pub cwd: Option<String>,
    pub rows: u16,
    pub cols: u16,
}

#[tauri::command]
pub fn pty_start<R: Runtime>(
    app: AppHandle<R>,
    state: State<PtyState>,
    args: StartArgs,
) -> Result<(), String> {
    // If a session with this id already exists, kill it first. This handles
    // React StrictMode's double-mount in dev cleanly.
    {
        let mut sessions = state.sessions.lock().map_err(|e| e.to_string())?;
        if let Some(mut existing) = sessions.remove(&args.id) {
            let _ = existing.killer.kill();
        }
    }

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: args.rows,
            cols: args.cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("openpty: {e}"))?;

    let mut cmd = CommandBuilder::new(&args.command);
    cmd.args(&args.args);
    if let Some(cwd) = args.cwd.as_deref() {
        cmd.cwd(cwd);
    }
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");

    let mut child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("spawn: {e}"))?;
    drop(pair.slave);

    let killer = child.clone_killer();
    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("clone_reader: {e}"))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("take_writer: {e}"))?;

    // Reader thread — emits PTY output as Tauri events.
    let id = args.id.clone();
    let app_clone = app.clone();
    let data_event = format!("pty://{id}/data");
    let exit_event = format!("pty://{id}/exit");
    thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let bytes = buf[..n].to_vec();
                    if app_clone.emit(&data_event, bytes).is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
        let _ = app_clone.emit(&exit_event, ());
    });

    // Wait thread — emits exit event when child terminates so the frontend
    // can update status. Doesn't block anything.
    let app_for_wait = app.clone();
    let exit_event_2 = format!("pty://{}/exit", args.id);
    thread::spawn(move || {
        let _ = child.wait();
        let _ = app_for_wait.emit(&exit_event_2, ());
    });

    let mut sessions = state.sessions.lock().map_err(|e| e.to_string())?;
    sessions.insert(
        args.id,
        PtySession {
            master: pair.master,
            writer,
            killer,
        },
    );

    Ok(())
}

#[tauri::command]
pub fn pty_write(
    state: State<PtyState>,
    id: String,
    data: Vec<u8>,
) -> Result<(), String> {
    let mut sessions = state.sessions.lock().map_err(|e| e.to_string())?;
    let s = sessions.get_mut(&id).ok_or("unknown pty session")?;
    s.writer.write_all(&data).map_err(|e| e.to_string())?;
    s.writer.flush().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn pty_resize(
    state: State<PtyState>,
    id: String,
    rows: u16,
    cols: u16,
) -> Result<(), String> {
    let sessions = state.sessions.lock().map_err(|e| e.to_string())?;
    let s = sessions.get(&id).ok_or("unknown pty session")?;
    s.master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn pty_close(state: State<PtyState>, id: String) -> Result<(), String> {
    let mut sessions = state.sessions.lock().map_err(|e| e.to_string())?;
    if let Some(mut s) = sessions.remove(&id) {
        let _ = s.killer.kill();
    }
    Ok(())
}
