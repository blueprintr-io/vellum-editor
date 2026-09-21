use std::sync::Mutex;
use tauri::AppHandle;

/// Version the user explicitly declined this session. A declined update
/// must not re-prompt on every periodic tick - that's nagware. Cleared
/// implicitly on relaunch (it's process state), and a NEWER version than
/// the snoozed one prompts again.
static SNOOZED_VERSION: Mutex<Option<String>> = Mutex::new(None);

/// How often the background check re-runs while the app stays open.
/// Vellum Core is offline-first: one small manifest GET per day is the
/// entire network footprint, and only when the user accepts do any
/// bytes beyond that move.
const UPDATE_CHECK_INTERVAL: std::time::Duration =
    std::time::Duration::from_secs(24 * 60 * 60);

/// Native file dialogs for the bundled editor, installed before page scripts.
/// The pickers use Tauri's dialog and fs plugins because WebView file access
/// varies by platform. The chosen path receives fs scope from the dialog
/// plugin. Downloads use the same bridge and report write errors.
///
/// Contract tests: tests/desktop-files.test.ts. The Blueprintr desktop shell
/// has a corresponding bridge in its own src-tauri/src/lib.rs.
const DESKTOP_FILES_JS: &str = r#"
(function () {
  if (window.__vellumDesktopFiles__) return;
  window.__vellumDesktopFiles__ = true;

  function internals() {
    var t = window.__TAURI_INTERNALS__;
    return t && typeof t.invoke === 'function' ? t : null;
  }
  function rejected(err) {
    var p = Promise.reject(err);
    p.catch(function () {});
    return p;
  }
  function ipc(cmd, payload, options) {
    var t = internals();
    if (!t) return rejected(new Error('Tauri bridge unavailable'));
    var p;
    try {
      p = t.invoke(cmd, payload, options);
    } catch (e) {
      return rejected(e);
    }
    if (p && p.catch) p.catch(function () {});
    return p;
  }

  function pickerFilters(types) {
    var filters = [];
    if (!Array.isArray(types)) return filters;
    types.forEach(function (t) {
      var extensions = [];
      if (t && t.accept) {
        Object.keys(t.accept).forEach(function (mime) {
          var exts = t.accept[mime];
          (Array.isArray(exts) ? exts : [exts]).forEach(function (e) {
            if (e) extensions.push(String(e).replace(/^\./, ''));
          });
        });
      }
      filters.push({ name: (t && t.description) || 'File', extensions: extensions });
    });
    return filters;
  }
  /* The fs plugin's write commands take the bytes as the IPC payload and
     the path + options as IPC headers (what @tauri-apps/plugin-fs does
     internally); a { path, contents } payload silently does nothing. */
  async function writeText(path, text) {
    var bytes = new TextEncoder().encode(text);
    await ipc('plugin:fs|write_text_file', bytes, {
      headers: { path: encodeURIComponent(path), options: JSON.stringify(undefined) },
    });
  }
  async function writeBinary(path, bytes) {
    await ipc('plugin:fs|write_file', bytes, {
      headers: { path: encodeURIComponent(path), options: JSON.stringify(undefined) },
    });
  }
  /* Binary read: the Open dialog also accepts PNG / SVG exports with the
     diagram source embedded and reads them via File.arrayBuffer(). */
  async function readBinary(path) {
    var arr = await ipc('plugin:fs|read_file', { path: path });
    if (Object.prototype.toString.call(arr) === '[object ArrayBuffer]') return new Uint8Array(arr);
    if (ArrayBuffer.isView(arr)) return new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
    return Uint8Array.from(arr);
  }
  function makeFsaHandle(path) {
    var name = String(path).replace(/^.*[/\\]/, '');
    return {
      kind: 'file',
      name: name,
      __path: path,
      createWritable: async function () {
        var p = path;
        return {
          write: async function (data) {
            var payload = data;
            if (data && typeof data === 'object' && 'data' in data) payload = data.data;
            if (typeof payload === 'string') {
              await writeText(p, payload);
            } else if (payload instanceof Blob) {
              await writeBinary(p, new Uint8Array(await payload.arrayBuffer()));
            } else if (payload instanceof ArrayBuffer) {
              await writeBinary(p, new Uint8Array(payload));
            } else if (payload && ArrayBuffer.isView(payload)) {
              await writeBinary(
                p,
                payload instanceof Uint8Array
                  ? payload
                  : new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength)
              );
            } else {
              await writeText(p, String(payload));
            }
          },
          close: async function () {},
          abort: async function () {},
        };
      },
      getFile: async function () {
        var bytes = await readBinary(path);
        return new File([bytes], name, { type: '' });
      },
    };
  }
  function definePicker(name, fn) {
    try {
      Object.defineProperty(window, name, { value: fn, writable: true, configurable: true });
    } catch (e) {
      window[name] = fn;
    }
  }
  definePicker('showSaveFilePicker', async function (opts) {
    opts = opts || {};
    var path = await ipc('plugin:dialog|save', {
      options: { defaultPath: opts.suggestedName, filters: pickerFilters(opts.types) },
    });
    if (!path) throw new DOMException('User cancelled the save dialog', 'AbortError');
    return makeFsaHandle(path);
  });
  definePicker('showOpenFilePicker', async function (opts) {
    opts = opts || {};
    var result = await ipc('plugin:dialog|open', {
      options: { multiple: !!opts.multiple, filters: pickerFilters(opts.types), directory: false },
    });
    if (!result) throw new DOMException('User cancelled the open dialog', 'AbortError');
    var paths = Array.isArray(result) ? result : [result];
    return paths.map(makeFsaHandle);
  });

  /* WKWebView refuses fetch() against in-document blob: URLs, so keep a
     url → Blob map alongside createObjectURL / revokeObjectURL. */
  var blobMap = new Map();
  var origCreate = URL.createObjectURL;
  URL.createObjectURL = function (obj) {
    var url = origCreate.call(URL, obj);
    if (obj instanceof Blob) blobMap.set(url, obj);
    return url;
  };
  var origRevoke = URL.revokeObjectURL;
  URL.revokeObjectURL = function (url) {
    blobMap.delete(url);
    return origRevoke.call(URL, url);
  };
  /* The editor awaits this bridge so success means the native write finished. */
  window.__vellumSaveBlob = async function (download, blob) {
    var ext = (download.match(/\.([^.]+)$/) || [])[1] || '';
    var path = await ipc('plugin:dialog|save', {
      options: {
        defaultPath: download,
        filters: ext ? [{ name: ext.toUpperCase(), extensions: [ext] }] : [],
      },
    });
    if (!path) return false;
    var isText =
      (blob.type || '').indexOf('text') >= 0 ||
      blob.type === 'image/svg+xml' ||
      blob.type === 'application/json' ||
      blob.type === 'application/x-yaml' ||
      blob.type === 'application/yaml';
    if (isText) await writeText(path, await blob.text());
    else await writeBinary(path, new Uint8Array(await blob.arrayBuffer()));
    return true;
  };
  var anchorClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    if (this.download && this.href) {
      var href = this.href;
      var download = this.download;
      (async function () {
        var blob = blobMap.has(href) ? blobMap.get(href) : await (await fetch(href)).blob();
        await window.__vellumSaveBlob(download, blob);
      })().catch(function (error) {
        var message = 'Could not export ' + download + ': ' + (error.message || String(error));
        window.dispatchEvent(new CustomEvent('vellum:export-error', { detail: { filename: download, message: message } }));
        window.alert(message);
      });
      return;
    }
    return anchorClick.apply(this, arguments);
  };
})();
"#;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        // Native save/open dialogs for the bundled editor on every
        // platform - see DESKTOP_FILES_JS. A plugin init script reaches
        // every webview without touching window creation.
        .plugin(
            tauri::plugin::Builder::<tauri::Wry>::new("vellum-desktop-files")
                .js_init_script(DESKTOP_FILES_JS.to_string())
                .build(),
        )
        .setup(|app| {
            // The main window is created here (tauri.conf.json sets
            // `create: false`) so the release workflow's smoke test can ask
            // for WebView2's remote debugging port through
            // VELLUM_CORE_REMOTE_DEBUG_PORT (127.0.0.1 only). WebView2
            // ignores the WEBVIEW2_* environment overrides once the app
            // passes explicit options, and Edge WebDriver's launch mode
            // never finds a Tauri app's pinned user-data folder - so the app
            // has to open the port itself. Effective on Windows only (a
            // no-op elsewhere); nothing sets it for users. wry's default
            // args are repeated because this call replaces them.
            let main_cfg = app
                .config()
                .app
                .windows
                .iter()
                .find(|w| w.label == "main")
                .cloned()
                .expect("tauri.conf.json must define a 'main' window");
            let builder = tauri::WebviewWindowBuilder::from_config(app, &main_cfg)?;
            let builder = match remote_debug_port() {
                Some(port) => builder.additional_browser_args(&format!(
                    "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --remote-debugging-port={port}"
                )),
                None => builder,
            };
            let _main_window = builder.build()?;

            // macOS auto-installs a default menu (File/Edit/Window/Help) when
            // no menu is set, and its accelerators (Cmd+N, Cmd+W, Cmd+Z,
            // Cmd+M, etc.) fire at the OS level BEFORE the webview's keydown
            // handler runs - so the JS keybindings never see them. Override
            // with a minimal App-only menu so those shortcuts fall through.
            // Cmd+X/C/V/A are deliberately NOT bound here either: the
            // canvas listens for native clipboard events directly.
            #[cfg(target_os = "macos")]
            {
                use tauri::menu::{
                    AboutMetadataBuilder, MenuBuilder, MenuItemBuilder, SubmenuBuilder,
                };
                let about = AboutMetadataBuilder::new()
                    .name(Some("Vellum Core"))
                    .version(Some(env!("CARGO_PKG_VERSION").to_string()))
                    .build();
                let check_updates_item =
                    MenuItemBuilder::with_id("check_for_updates", "Check for Updates…")
                        .build(app)?;
                let app_submenu = SubmenuBuilder::new(app, "Vellum Core")
                    .about(Some(about))
                    .separator()
                    .item(&check_updates_item)
                    .separator()
                    .services()
                    .separator()
                    .hide()
                    .hide_others()
                    .show_all()
                    .separator()
                    .quit()
                    .build()?;
                let menu = MenuBuilder::new(app).items(&[&app_submenu]).build()?;
                app.set_menu(menu)?;
                app.on_menu_event(|app, event| {
                    if event.id().as_ref() == "check_for_updates" {
                        let handle = app.clone();
                        tauri::async_runtime::spawn(async move {
                            check_for_updates(handle, true).await;
                        });
                    }
                });
            }

            // VELLUM_CORE_DISABLE_UPDATER: set by the release workflow's
            // WebDriver smoke test (scripts/e2e/webdriver-smoke.mjs). The
            // update prompt is a blocking native dialog; under WebDriver it
            // would freeze the run. Nothing sets it for users; it can only
            // turn the checks OFF.
            let updater_disabled = std::env::var_os("VELLUM_CORE_DISABLE_UPDATER").is_some();
            if updater_disabled {
                eprintln!("[updater] disabled by VELLUM_CORE_DISABLE_UPDATER");
            } else {
                // Prompted update check on launch + a daily re-check while the
                // app stays open. `interactive=false` keeps failures and the
                // up-to-date case silent; an available update always prompts
                // before anything is downloaded.
                let handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    check_for_updates(handle, false).await;
                });
                let periodic = app.handle().clone();
                std::thread::spawn(move || loop {
                    std::thread::sleep(UPDATE_CHECK_INTERVAL);
                    let handle = periodic.clone();
                    tauri::async_runtime::spawn(async move {
                        check_for_updates(handle, false).await;
                    });
                });
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// The WebView2 remote-debugging port requested through
/// `VELLUM_CORE_REMOTE_DEBUG_PORT`, when it is a valid non-zero TCP port.
/// Only the release workflow's smoke test sets it (see setup()).
fn remote_debug_port() -> Option<u16> {
    std::env::var("VELLUM_CORE_REMOTE_DEBUG_PORT")
        .ok()?
        .trim()
        .parse::<u16>()
        .ok()
        .filter(|port| *port > 0)
}

/// Check downloads.blueprintr.io/core/updater.json and, when a newer
/// version exists, ask the user before downloading anything. `interactive`
/// (the macOS "Check for Updates…" menu item) additionally surfaces the
/// up-to-date and error outcomes; the launch/periodic path stays silent
/// for those.
///
/// The prompt-first flow is deliberate: Vellum Core's pitch is "local
/// files, no account, zero telemetry", so the app never silently pulls
/// binaries. Declining parks that version in SNOOZED_VERSION so the
/// periodic re-check doesn't nag; a manual menu check always re-asks.
async fn check_for_updates(app: AppHandle, interactive: bool) {
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
    use tauri_plugin_updater::UpdaterExt;

    let updater = match app.updater() {
        Ok(u) => u,
        Err(e) => {
            eprintln!("[updater] init failed: {e}");
            if interactive {
                app.dialog()
                    .message("Couldn't initialise the updater.")
                    .kind(MessageDialogKind::Error)
                    .title("Check for Updates")
                    .blocking_show();
            }
            return;
        }
    };
    let maybe_update = match updater.check().await {
        Ok(m) => m,
        Err(e) => {
            eprintln!("[updater] check failed: {e}");
            if interactive {
                app.dialog()
                    .message("Couldn't reach the update server. Try again later.")
                    .kind(MessageDialogKind::Error)
                    .title("Check for Updates")
                    .blocking_show();
            }
            return;
        }
    };
    let Some(update) = maybe_update else {
        if interactive {
            app.dialog()
                .message(format!(
                    "You're running the latest version ({}).",
                    env!("CARGO_PKG_VERSION")
                ))
                .title("Check for Updates")
                .blocking_show();
        }
        return;
    };

    if !interactive {
        let snoozed = SNOOZED_VERSION
            .lock()
            .expect("snoozed-version mutex poisoned")
            .clone();
        if snoozed.as_deref() == Some(update.version.as_str()) {
            return;
        }
    }

    let install = app
        .dialog()
        .message(format!(
            "Vellum Core {} is available (you have {}).\n\nInstall it now? \
             The app will restart when it's done.",
            update.version,
            env!("CARGO_PKG_VERSION"),
        ))
        .title("Update available")
        .buttons(MessageDialogButtons::OkCancelCustom(
            "Install & Restart".to_string(),
            "Later".to_string(),
        ))
        .blocking_show();
    if !install {
        *SNOOZED_VERSION
            .lock()
            .expect("snoozed-version mutex poisoned") = Some(update.version.clone());
        return;
    }

    match update.download_and_install(|_progress, _total| {}, || {}).await {
        Ok(()) => {
            // On Windows the NSIS installer may have already torn the
            // process down before we get here; on macOS/Linux the new
            // bits are staged and restart() activates them.
            app.dialog()
                .message(format!(
                    "Vellum Core {} installed - restarting.",
                    update.version
                ))
                .title("Update installed")
                .blocking_show();
            app.restart();
        }
        Err(e) => {
            eprintln!("[updater] download/install failed: {e}");
            app.dialog()
                .message("The update failed to download. Try again later.")
                .kind(MessageDialogKind::Error)
                .title("Update failed")
                .blocking_show();
        }
    }
}
