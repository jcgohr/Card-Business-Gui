mod db;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

const FIREBASE_API_KEY: &str = "AIzaSyBevqD-xnn_MlhYeycr3VGFf6-ZzCtKng4";
const CARDUPLOADER_BASE: &str = "https://carduploader.com/backend";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct Config {
    pub watch_folder: String,
    pub email: String,
    pub password: String,
    pub tcg: String,
    pub platform: String,
    pub condition: String,
    pub start_price: String,
    pub box_prefix: String,
    pub current_section: u32,
    pub sku_increment: bool,
    pub auto_crop: bool,
    pub images_per_card: u32,
    pub auction_duration: u32,
    pub space_out_enabled: bool,
    pub space_out_interval: u32,
    pub best_offer: u32,
    pub store_category: String,
    pub store_category2: String,
    pub auction_scheduled_time: String,
    pub fixed_price_scheduled_time: String,
    pub matching_exclude_sets: Vec<String>,
    pub matching_prioritize_sets: Vec<String>,
    pub matching_exclude_terms: Vec<String>,
    pub matching_prioritize_terms: Vec<String>,
    pub image_extensions: Vec<String>,
    pub folder_settle_delay: u32,
    pub blacklisted_folders: Vec<String>,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            watch_folder: String::new(),
            email: String::new(),
            password: String::new(),
            tcg: "pokemon japanese".into(),
            platform: "standard".into(),
            condition: "NM".into(),
            start_price: "0.99".into(),
            box_prefix: String::new(),
            current_section: 1,
            sku_increment: true,
            auto_crop: true,
            images_per_card: 2,
            auction_duration: 7,
            space_out_enabled: false,
            space_out_interval: 5,
            best_offer: 0,
            store_category: String::new(),
            store_category2: String::new(),
            auction_scheduled_time: String::new(),
            fixed_price_scheduled_time: String::new(),
            matching_exclude_sets: vec![],
            matching_prioritize_sets: vec![],
            matching_exclude_terms: vec![],
            matching_prioritize_terms: vec![],
            image_extensions: vec![".jpg".into(), ".jpeg".into(), ".png".into(), ".webp".into()],
            folder_settle_delay: 5,
            blacklisted_folders: vec![],
        }
    }
}

fn config_path(app: &AppHandle) -> PathBuf {
    app.path().app_data_dir().unwrap().join("card_uploader_config.json")
}

fn build_sku_prefix(config: &Config) -> String {
    let box_part = config.box_prefix.trim();
    if box_part.is_empty() {
        format!("{}-1", config.current_section)
    } else {
        format!("{}-{}-1", box_part, config.current_section)
    }
}

// ---------------------------------------------------------------------------
// App state
// ---------------------------------------------------------------------------

#[derive(Default)]
struct AuthTokens {
    id_token: String,
    refresh_token: String,
    expires_at: u64, // unix seconds
}

struct WatcherState {
    stop_tx: Option<tokio::sync::watch::Sender<bool>>,
    running: bool,
    active_count: i32,
}

impl Default for WatcherState {
    fn default() -> Self {
        Self { stop_tx: None, running: false, active_count: 0 }
    }
}

pub struct AppState {
    auth: Mutex<AuthTokens>,
    watcher: Mutex<WatcherState>,
    db: Mutex<rusqlite::Connection>,
}

impl AppState {
    fn new(db_conn: rusqlite::Connection) -> Self {
        Self {
            auth: Mutex::new(AuthTokens::default()),
            watcher: Mutex::new(WatcherState::default()),
            db: Mutex::new(db_conn),
        }
    }
}

// ---------------------------------------------------------------------------
// Log helper
// ---------------------------------------------------------------------------

#[derive(Clone, Serialize)]
struct LogEvent {
    level: String,
    message: String,
}

fn emit_log(app: &AppHandle, level: &str, msg: &str) {
    let _ = app.emit("log-message", LogEvent {
        level: level.into(),
        message: msg.into(),
    });
}

fn emit_status(app: &AppHandle, running: bool, active: i32) {
    #[derive(Clone, Serialize)]
    struct StatusEvent { running: bool, active_count: i32 }
    let _ = app.emit("watcher-status", StatusEvent { running, active_count: active });
}

fn emit_section(app: &AppHandle, section: u32) {
    #[derive(Clone, Serialize)]
    struct SectionEvent { section: u32 }
    let _ = app.emit("section-updated", SectionEvent { section });
}

// ---------------------------------------------------------------------------
// Firebase auth
// ---------------------------------------------------------------------------

async fn firebase_sign_in(email: &str, password: &str) -> Result<AuthTokens, String> {
    let client = reqwest::Client::new();
    let resp = client
        .post(format!(
            "https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key={}",
            FIREBASE_API_KEY
        ))
        .json(&serde_json::json!({
            "returnSecureToken": true,
            "email": email,
            "password": password,
            "clientType": "CLIENT_TYPE_WEB"
        }))
        .timeout(Duration::from_secs(15))
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !resp.status().is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("Firebase sign-in failed: {}", body));
    }

    let data: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    let expires_in: u64 = data["expiresIn"].as_str()
        .and_then(|s| s.parse().ok())
        .unwrap_or(3600);
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs();

    Ok(AuthTokens {
        id_token: data["idToken"].as_str().unwrap_or("").to_string(),
        refresh_token: data["refreshToken"].as_str().unwrap_or("").to_string(),
        expires_at: now + expires_in,
    })
}

async fn firebase_refresh(refresh_token: &str) -> Result<AuthTokens, String> {
    let client = reqwest::Client::new();
    let resp = client
        .post(format!(
            "https://securetoken.googleapis.com/v1/token?key={}",
            FIREBASE_API_KEY
        ))
        .form(&[("grant_type", "refresh_token"), ("refresh_token", refresh_token)])
        .timeout(Duration::from_secs(15))
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !resp.status().is_success() {
        return Err("Token refresh failed".into());
    }

    let data: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    let expires_in: u64 = data["expires_in"].as_str()
        .and_then(|s| s.parse().ok())
        .unwrap_or(3600);
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs();

    Ok(AuthTokens {
        id_token: data["id_token"].as_str().unwrap_or("").to_string(),
        refresh_token: data["refresh_token"].as_str().unwrap_or("").to_string(),
        expires_at: now + expires_in,
    })
}

async fn get_token(
    state: &Arc<AppState>,
    email: &str,
    password: &str,
) -> Result<String, String> {
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs();
    let (needs_refresh, has_refresh, refresh_token) = {
        let auth = state.auth.lock().unwrap();
        let needs = auth.id_token.is_empty() || now >= auth.expires_at.saturating_sub(300);
        let has = !auth.refresh_token.is_empty();
        (needs, has, auth.refresh_token.clone())
    };

    if needs_refresh {
        let new_tokens = if has_refresh {
            firebase_refresh(&refresh_token).await.unwrap_or_else(|_| AuthTokens::default())
        } else {
            AuthTokens::default()
        };

        let new_tokens = if new_tokens.id_token.is_empty() {
            firebase_sign_in(email, password).await?
        } else {
            new_tokens
        };

        let token = new_tokens.id_token.clone();
        *state.auth.lock().unwrap() = new_tokens;
        Ok(token)
    } else {
        Ok(state.auth.lock().unwrap().id_token.clone())
    }
}

// ---------------------------------------------------------------------------
// Image pairing
// ---------------------------------------------------------------------------

fn pair_images(folder: &Path, extensions: &[String], images_per_card: u32) -> Vec<Vec<PathBuf>> {
    let mut files: Vec<PathBuf> = folder
        .read_dir()
        .unwrap()
        .flatten()
        .map(|e| e.path())
        .filter(|p| {
            p.is_file()
                && extensions.iter().any(|ext| {
                    p.extension()
                        .and_then(|e| e.to_str())
                        .map(|e| format!(".{}", e.to_lowercase()) == *ext)
                        .unwrap_or(false)
                })
        })
        .collect();
    files.sort();

    if files.is_empty() {
        return vec![];
    }

    if images_per_card == 1 {
        return files.into_iter().map(|f| vec![f]).collect();
    }

    // Try _A / _B convention
    let fronts: Vec<&PathBuf> = files
        .iter()
        .filter(|p| p.file_stem().and_then(|s| s.to_str()).map(|s| s.to_uppercase().ends_with("_A")).unwrap_or(false))
        .collect();

    if !fronts.is_empty() {
        let backs_by_base: HashMap<String, &PathBuf> = files
            .iter()
            .filter(|p| p.file_stem().and_then(|s| s.to_str()).map(|s| s.to_uppercase().ends_with("_B")).unwrap_or(false))
            .map(|p| {
                let stem = p.file_stem().unwrap().to_str().unwrap().to_uppercase();
                (stem[..stem.len() - 2].to_string(), p)
            })
            .collect();

        return fronts.iter().map(|front| {
            let stem = front.file_stem().unwrap().to_str().unwrap().to_uppercase();
            let base = &stem[..stem.len() - 2];
            match backs_by_base.get(base) {
                Some(back) => vec![(*front).clone(), (*back).clone()],
                None => vec![(*front).clone()],
            }
        }).collect();
    }

    // Sequential fallback
    files.chunks(2).map(|c| c.to_vec()).collect()
}

// ---------------------------------------------------------------------------
// CardUploader API
// ---------------------------------------------------------------------------

async fn get_signed_urls(
    token: &str,
    pairs: &[Vec<PathBuf>],
) -> Result<(Vec<serde_json::Value>, String), String> {
    let job_id = format!("temp-{}", SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis());

    let mut files_meta = vec![];
    for (pair_idx, pair) in pairs.iter().enumerate() {
        for (img_idx, img_path) in pair.iter().enumerate() {
            let size = std::fs::metadata(img_path).map(|m| m.len()).unwrap_or(0);
            let ext = img_path.extension().and_then(|e| e.to_str()).unwrap_or("jpg").to_lowercase();
            let mime = match ext.as_str() {
                "png" => "image/png",
                "webp" => "image/webp",
                _ => "image/jpeg",
            };
            files_meta.push(serde_json::json!({
                "fileName": img_path.file_name().unwrap().to_str().unwrap(),
                "fileType": mime,
                "fileSize": size,
                "jobId": job_id,
                "pairIndex": pair_idx,
                "imageIndex": img_idx,
            }));
        }
    }

    let client = reqwest::Client::new();
    let resp = client
        .post(format!("{}/upload-card-pair/batch-signed-urls", CARDUPLOADER_BASE))
        .bearer_auth(token)
        .json(&serde_json::json!({ "files": files_meta }))
        .timeout(Duration::from_secs(30))
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !resp.status().is_success() {
        return Err(format!("Signed URL request failed: {}", resp.status()));
    }

    let data: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    let signed_list = if data.is_array() {
        data.as_array().unwrap().clone()
    } else if let Some(arr) = data.get("signedUrls").and_then(|v| v.as_array()) {
        arr.clone()
    } else if let Some(arr) = data.get("urls").and_then(|v| v.as_array()) {
        arr.clone()
    } else if let Some(arr) = data.get("files").and_then(|v| v.as_array()) {
        arr.clone()
    } else {
        return Err(format!("Cannot parse signed URL response: {}", data));
    };

    Ok((signed_list, job_id))
}

async fn upload_to_r2(
    app: &AppHandle,
    signed_list: &[serde_json::Value],
    pairs: &[Vec<PathBuf>],
) -> Result<Vec<serde_json::Value>, String> {
    // Build (pairIndex, imageIndex) -> entry map
    let mut url_map: HashMap<(usize, usize), &serde_json::Value> = HashMap::new();
    for entry in signed_list {
        let pi = entry.get("pairIndex").or_else(|| entry.get("pair_index"))
            .and_then(|v| v.as_u64()).unwrap_or(0) as usize;
        let ii = entry.get("imageIndex").or_else(|| entry.get("image_index"))
            .and_then(|v| v.as_u64()).unwrap_or(0) as usize;
        url_map.insert((pi, ii), entry);
    }

    let total: usize = pairs.iter().map(|p| p.len()).sum();
    let done_count = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let client = Arc::new(reqwest::Client::new());

    let mut tasks = vec![];
    for (pair_idx, pair) in pairs.iter().enumerate() {
        for (img_idx, img_path) in pair.iter().enumerate() {
            let entry = url_map.get(&(pair_idx, img_idx))
                .ok_or_else(|| format!("No signed URL for pair={} img={}", pair_idx, img_idx))?;

            let signed_url = entry.get("signedUrl")
                .or_else(|| entry.get("signed_url"))
                .or_else(|| entry.get("url"))
                .and_then(|v| v.as_str())
                .ok_or("No upload URL in signed URL entry")?
                .to_string();

            let r2_key = entry.get("key").or_else(|| entry.get("s3Key")).or_else(|| entry.get("s3_key"))
                .and_then(|v| v.as_str()).map(|s| s.to_string());

            let s3_url = entry.get("s3Url").or_else(|| entry.get("s3_url"))
                .or_else(|| entry.get("publicUrl")).or_else(|| entry.get("public_url"))
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
                .or_else(|| r2_key.as_ref().map(|k| format!("https://images.carduploader.com/{}", k)))
                .ok_or("Cannot determine s3_url")?;

            let img_path = img_path.clone();
            let client = Arc::clone(&client);
            let done_count = Arc::clone(&done_count);
            let app = app.clone();
            let ext = img_path.extension().and_then(|e| e.to_str()).unwrap_or("jpg").to_lowercase();
            let mime = match ext.as_str() {
                "png" => "image/png",
                "webp" => "image/webp",
                _ => "image/jpeg",
            }.to_string();

            tasks.push(tokio::spawn(async move {
                let file_size = std::fs::metadata(&img_path).map(|m| m.len()).unwrap_or(0);
                let bytes = std::fs::read(&img_path).map_err(|e| e.to_string())?;
                let fname = img_path.file_name().unwrap().to_str().unwrap().to_string();

                for attempt in 0..4u32 {
                    let resp = client.put(&signed_url)
                        .header("Content-Type", &mime)
                        .header("Content-Length", file_size.to_string())
                        .header("Cache-Control", "public, max-age=31536000, immutable")
                        .body(bytes.clone())
                        .timeout(Duration::from_secs(120))
                        .send()
                        .await;

                    match resp {
                        Ok(r) if r.status().is_success() => break,
                        Ok(r) => {
                            if attempt == 3 {
                                return Err(format!("Upload failed for {}: {}", fname, r.status()));
                            }
                            tokio::time::sleep(Duration::from_secs(2u64.pow(attempt))).await;
                        }
                        Err(e) => {
                            if attempt == 3 {
                                return Err(format!("Upload error for {}: {}", fname, e));
                            }
                            tokio::time::sleep(Duration::from_secs(2u64.pow(attempt))).await;
                        }
                    }
                }

                let n = done_count.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1;
                emit_log(&app, "info", &format!("[{}/{}] Uploaded {}", n, total, fname));

                Ok::<serde_json::Value, String>(serde_json::json!({
                    "filename": fname,
                    "s3_url": s3_url,
                    "key": r2_key,
                    "size": file_size,
                    "originalSize": file_size,
                    "pairIndex": pair_idx,
                    "imageIndex": img_idx,
                }))
            }));
        }
    }

    let mut results: Vec<(usize, usize, serde_json::Value)> = vec![];
    for task in tasks {
        match task.await {
            Ok(Ok(v)) => {
                let pi = v["pairIndex"].as_u64().unwrap_or(0) as usize;
                let ii = v["imageIndex"].as_u64().unwrap_or(0) as usize;
                results.push((pi, ii, v));
            }
            Ok(Err(e)) => return Err(e),
            Err(e) => return Err(e.to_string()),
        }
    }

    results.sort_by_key(|(pi, ii, _)| (*pi, *ii));
    Ok(results.into_iter().map(|(_, _, v)| v).collect())
}

async fn process_cards(
    token: &str,
    uploaded: &[serde_json::Value],
    config: &Config,
) -> Result<String, String> {
    let client = reqwest::Client::new();
    let params = [
        ("uploaded_files", serde_json::to_string(uploaded).unwrap()),
        ("tcg", config.tcg.clone()),
        ("sku_prefix", build_sku_prefix(config)),
        ("sku_increment", config.sku_increment.to_string()),
        ("start_price", config.start_price.clone()),
        ("store_category", config.store_category.clone()),
        ("store_category2", config.store_category2.clone()),
        ("auction_duration", config.auction_duration.to_string()),
        ("auction_scheduled_time", config.auction_scheduled_time.clone()),
        ("space_out_enabled", config.space_out_enabled.to_string()),
        ("space_out_interval", config.space_out_interval.to_string()),
        ("condition", config.condition.clone()),
        ("best_offer", config.best_offer.to_string()),
        ("fixed_price_scheduled_time", config.fixed_price_scheduled_time.clone()),
        ("auto_crop", config.auto_crop.to_string()),
        ("images_per_card", config.images_per_card.to_string()),
        ("matching_exclude_sets", serde_json::to_string(&config.matching_exclude_sets).unwrap()),
        ("matching_prioritize_sets", serde_json::to_string(&config.matching_prioritize_sets).unwrap()),
        ("matching_exclude_terms", serde_json::to_string(&config.matching_exclude_terms).unwrap()),
        ("matching_prioritize_terms", serde_json::to_string(&config.matching_prioritize_terms).unwrap()),
        ("platform", config.platform.clone()),
    ];

    let resp = client
        .post(format!("{}/process-cards", CARDUPLOADER_BASE))
        .bearer_auth(token)
        .form(&params)
        .timeout(Duration::from_secs(30))
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !resp.status().is_success() {
        return Err(format!("process-cards failed: {}", resp.status()));
    }

    let data: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    let job_id = data.get("jobId").or_else(|| data.get("job_id")).or_else(|| data.get("id"))
        .and_then(|v| v.as_str())
        .ok_or_else(|| format!("No job ID in process-cards response: {}", data))?
        .to_string();

    Ok(job_id)
}

async fn poll_job(
    app: &AppHandle,
    token: &str,
    job_id: &str,
    mut stop_rx: tokio::sync::watch::Receiver<bool>,
) -> Result<String, String> {
    let client = reqwest::Client::new();
    loop {
        if *stop_rx.borrow() {
            return Ok("cancelled".into());
        }

        let resp = client
            .get(format!("{}/jobs/{}", CARDUPLOADER_BASE, job_id))
            .bearer_auth(token)
            .timeout(Duration::from_secs(15))
            .send()
            .await
            .map_err(|e| e.to_string())?;

        let job: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
        let status = job.get("status").and_then(|v| v.as_str()).unwrap_or("unknown");

        let progress = job.get("progress").or_else(|| job.get("processed")).and_then(|v| v.as_u64());
        let total = job.get("total").or_else(|| job.get("card_count")).and_then(|v| v.as_u64());
        if let (Some(p), Some(t)) = (progress, total) {
            emit_log(app, "info", &format!("Job status: {} ({}/{})", status, p, t));
        } else {
            emit_log(app, "info", &format!("Job status: {}", status));
        }

        if matches!(status, "completed" | "failed" | "error" | "done") {
            return Ok(status.to_string());
        }

        tokio::select! {
            _ = tokio::time::sleep(Duration::from_secs(3)) => {}
            _ = stop_rx.changed() => {
                if *stop_rx.borrow() { return Ok("cancelled".into()); }
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Folder processing pipeline
// ---------------------------------------------------------------------------

async fn run_process_folder(
    app: AppHandle,
    state: Arc<AppState>,
    folder: PathBuf,
    config: Config,
    stop_rx: tokio::sync::watch::Receiver<bool>,
) {
    let name = folder.file_name().unwrap_or_default().to_string_lossy().to_string();
    emit_log(&app, "info", &format!("--- Processing: {} | SKU: {} ---", name, build_sku_prefix(&config)));

    let token = match get_token(&state, &config.email, &config.password).await {
        Ok(t) => t,
        Err(e) => { emit_log(&app, "error", &format!("Auth failed: {}", e)); return; }
    };

    let pairs = pair_images(&folder, &config.image_extensions, config.images_per_card);
    if pairs.is_empty() {
        emit_log(&app, "warn", &format!("No images found in {}, skipping.", name));
        return;
    }
    emit_log(&app, "info", &format!("Found {} card(s) ({} images)", pairs.len(), pairs.iter().map(|p| p.len()).sum::<usize>()));

    let (signed_list, _) = match get_signed_urls(&token, &pairs).await {
        Ok(v) => v,
        Err(e) => { emit_log(&app, "error", &format!("Signed URL error: {}", e)); return; }
    };

    let uploaded = match upload_to_r2(&app, &signed_list, &pairs).await {
        Ok(v) => v,
        Err(e) => { emit_log(&app, "error", &format!("Upload error: {}", e)); return; }
    };

    let job_id = match process_cards(&token, &uploaded, &config).await {
        Ok(id) => id,
        Err(e) => { emit_log(&app, "error", &format!("process-cards error: {}", e)); return; }
    };
    emit_log(&app, "info", &format!("Job created: {}", job_id));

    // Increment section immediately after submission
    let new_section = {
        // We don't mutate config here; the frontend holds the authoritative config.
        // Just emit the event so the UI can update.
        config.current_section + 1
    };
    emit_section(&app, new_section);
    emit_log(&app, "info", &format!("Section incremented to {}", new_section));

    let status = match poll_job(&app, &token, &job_id, stop_rx).await {
        Ok(s) => s,
        Err(e) => { emit_log(&app, "error", &format!("Poll error: {}", e)); return; }
    };

    if matches!(status.as_str(), "completed" | "done") {
        emit_log(&app, "info", &format!("Done! {} processed successfully.", name));
    } else {
        emit_log(&app, "warn", &format!("Job ended with status: {}", status));
    }
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

#[tauri::command]
async fn load_config(app: AppHandle) -> Result<Config, String> {
    let path = config_path(&app);
    if !path.exists() {
        return Ok(Config::default());
    }
    let text = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let config: Config = serde_json::from_str(&text).unwrap_or_default();
    Ok(config)
}

#[tauri::command]
async fn save_config(app: AppHandle, config: Config) -> Result<(), String> {
    let path = config_path(&app);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    // Never persist credentials to disk
    let mut clean = config.clone();
    clean.email = String::new();
    clean.password = String::new();
    let text = serde_json::to_string_pretty(&clean).map_err(|e| e.to_string())?;
    std::fs::write(&path, text).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
async fn get_sku_preview(box_prefix: String, current_section: u32) -> String {
    let config = Config { box_prefix, current_section, ..Config::default() };
    build_sku_prefix(&config)
}

#[tauri::command]
async fn select_directory() -> Option<String> {
    rfd::AsyncFileDialog::new()
        .set_title("Select Folder")
        .pick_folder()
        .await
        .map(|f| f.path().to_string_lossy().to_string())
}

#[tauri::command]
async fn start_watcher(
    app: AppHandle,
    state: tauri::State<'_, Arc<AppState>>,
    config: Config,
) -> Result<(), String> {
    let mut ws = state.watcher.lock().unwrap();
    if ws.running {
        return Err("Watcher already running".into());
    }

    let watch_folder = PathBuf::from(&config.watch_folder);
    if !watch_folder.exists() {
        return Err(format!("Watch folder does not exist: {}", config.watch_folder));
    }

    let (stop_tx, stop_rx) = tokio::sync::watch::channel(false);
    ws.stop_tx = Some(stop_tx);
    ws.running = true;
    drop(ws);

    emit_status(&app, true, 0);
    emit_log(&app, "info", &format!("Watching: {}", config.watch_folder));

    let state_arc = Arc::clone(&state);
    let app_clone = app.clone();
    let config_arc = Arc::new(config);
    let blacklist: std::collections::HashSet<String> = config_arc.blacklisted_folders
        .iter().map(|s| s.to_lowercase()).collect();
    let settle_delay = config_arc.folder_settle_delay;

    tokio::spawn(async move {
        use notify::{Watcher, RecursiveMode, Event};
        use notify::event::{EventKind, CreateKind};

        let (tx, mut rx) = tokio::sync::mpsc::channel::<PathBuf>(64);

        let tx_clone = tx.clone();
        let mut watcher = notify::RecommendedWatcher::new(
            move |res: Result<Event, _>| {
                if let Ok(event) = res {
                    if matches!(event.kind, EventKind::Create(CreateKind::Folder)) {
                        for path in event.paths {
                            let _ = tx_clone.blocking_send(path);
                        }
                    }
                }
            },
            notify::Config::default(),
        ).expect("Failed to create watcher");

        watcher.watch(&watch_folder, RecursiveMode::NonRecursive).expect("Failed to watch");

        // Per-folder debounce: track pending abort handles
        let mut pending: HashMap<PathBuf, tokio::task::JoinHandle<()>> = HashMap::new();
        let mut stop_rx_clone = stop_rx.clone();

        loop {
            tokio::select! {
                Some(path) = rx.recv() => {
                    let folder_name = path.file_name().unwrap_or_default().to_string_lossy().to_lowercase();
                    if blacklist.contains(folder_name.as_str()) {
                        continue;
                    }

                    emit_log(&app_clone, "info", &format!(
                        "New folder detected: {} — waiting {}s to settle...",
                        path.file_name().unwrap_or_default().to_string_lossy(),
                        settle_delay
                    ));

                    // Cancel existing pending task for this folder
                    if let Some(handle) = pending.remove(&path) {
                        handle.abort();
                    }

                    let app2 = app_clone.clone();
                    let state2 = Arc::clone(&state_arc);
                    let config2 = Arc::clone(&config_arc);
                    let path2 = path.clone();
                    let stop_rx2 = stop_rx.clone();

                    let handle = tokio::spawn(async move {
                        tokio::time::sleep(Duration::from_secs(settle_delay as u64)).await;

                        {
                            let mut ws = state2.watcher.lock().unwrap();
                            ws.active_count += 1;
                            let (r, a) = (ws.running, ws.active_count);
                            drop(ws);
                            emit_status(&app2, r, a);
                        }

                        run_process_folder(app2.clone(), state2.clone(), path2, (*config2).clone(), stop_rx2).await;

                        {
                            let mut ws = state2.watcher.lock().unwrap();
                            ws.active_count = (ws.active_count - 1).max(0);
                            let (r, a) = (ws.running, ws.active_count);
                            drop(ws);
                            emit_status(&app2, r, a);
                        }
                    });

                    pending.insert(path, handle);
                }
                _ = stop_rx_clone.changed() => {
                    if *stop_rx_clone.borrow() { break; }
                }
            }
        }

        for (_, handle) in pending {
            handle.abort();
        }
    });

    Ok(())
}

#[tauri::command]
async fn stop_watcher(
    app: AppHandle,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<(), String> {
    let mut ws = state.watcher.lock().unwrap();
    if let Some(tx) = ws.stop_tx.take() {
        let _ = tx.send(true);
    }
    ws.running = false;
    ws.active_count = 0;
    drop(ws);
    emit_status(&app, false, 0);
    emit_log(&app, "info", "Watcher stopped.");
    Ok(())
}

#[tauri::command]
async fn process_folder_manual(
    app: AppHandle,
    state: tauri::State<'_, Arc<AppState>>,
    folder_path: String,
    config: Config,
) -> Result<(), String> {
    let folder = PathBuf::from(&folder_path);
    if !folder.exists() {
        return Err(format!("Folder does not exist: {}", folder_path));
    }

    let state_arc = Arc::clone(&state);
    let (_, stop_rx) = tokio::sync::watch::channel(false);

    {
        let mut ws = state_arc.watcher.lock().unwrap();
        ws.active_count += 1;
        let (r, a) = (ws.running, ws.active_count);
        drop(ws);
        emit_status(&app, r, a);
    }

    let app2 = app.clone();
    tokio::spawn(async move {
        run_process_folder(app2.clone(), state_arc.clone(), folder, config, stop_rx).await;
        let mut ws = state_arc.watcher.lock().unwrap();
        ws.active_count = (ws.active_count - 1).max(0);
        let (r, a) = (ws.running, ws.active_count);
        drop(ws);
        emit_status(&app2, r, a);
    });

    Ok(())
}

#[tauri::command]
async fn process_all_subfolders(
    app: AppHandle,
    state: tauri::State<'_, Arc<AppState>>,
    parent_path: String,
    config: Config,
) -> Result<(), String> {
    let parent = PathBuf::from(&parent_path);
    let blacklist: std::collections::HashSet<String> = config.blacklisted_folders
        .iter().map(|s| s.to_lowercase()).collect();

    let mut subfolders: Vec<PathBuf> = parent.read_dir()
        .map_err(|e| e.to_string())?
        .flatten()
        .map(|e| e.path())
        .filter(|p| {
            p.is_dir() && !blacklist.contains(
                &p.file_name().unwrap_or_default().to_string_lossy().to_lowercase()
            )
        })
        .collect();

    subfolders.sort_by_key(|p| p.metadata().and_then(|m| m.created()).ok());

    if subfolders.is_empty() {
        emit_log(&app, "warn", "No eligible subfolders found.");
        return Ok(());
    }

    let total = subfolders.len();
    emit_log(&app, "info", &format!("Found {} subfolder(s) — processing in creation-time order...", total));

    let state_arc = Arc::clone(&state);
    let (_, stop_rx) = tokio::sync::watch::channel(false);

    {
        let mut ws = state_arc.watcher.lock().unwrap();
        ws.active_count += 1;
        let (r, a) = (ws.running, ws.active_count);
        drop(ws);
        emit_status(&app, r, a);
    }

    let app2 = app.clone();
    tokio::spawn(async move {
        for (idx, folder) in subfolders.iter().enumerate() {
            emit_log(&app2, "info", &format!("[{}/{}] Submitting: {}", idx + 1, total,
                folder.file_name().unwrap_or_default().to_string_lossy()));
            run_process_folder(app2.clone(), state_arc.clone(), folder.clone(), config.clone(), stop_rx.clone()).await;
        }
        let mut ws = state_arc.watcher.lock().unwrap();
        ws.active_count = (ws.active_count - 1).max(0);
        let (r, a) = (ws.running, ws.active_count);
        drop(ws);
        emit_status(&app2, r, a);
    });

    Ok(())
}

#[tauri::command]
async fn test_auth(
    state: tauri::State<'_, Arc<AppState>>,
    config: Config,
) -> Result<String, String> {
    get_token(&state, &config.email, &config.password).await?;
    Ok("Authentication successful".into())
}

// ---------------------------------------------------------------------------
// Inventory & Fulfillment commands
// ---------------------------------------------------------------------------

#[tauri::command]
async fn select_file(filter_name: String, filter_ext: String) -> Option<String> {
    rfd::AsyncFileDialog::new()
        .set_title("Select File")
        .add_filter(&filter_name, &[filter_ext.as_str()])
        .pick_file()
        .await
        .map(|f| f.path().to_string_lossy().to_string())
}

#[tauri::command]
fn preview_inventory_csv(path: String) -> Result<Vec<String>, String> {
    let raw = std::fs::read(&path).map_err(|e| e.to_string())?;
    let data = if raw.starts_with(&[0xEF, 0xBB, 0xBF]) { raw[3..].to_vec() } else { raw };

    let mut rdr = csv::Reader::from_reader(data.as_slice());
    let headers: Vec<String> = rdr
        .headers()
        .map_err(|e| e.to_string())?
        .iter()
        .map(|s| s.to_string())
        .collect();

    let norm = |s: &str| -> String {
        s.to_lowercase().chars().filter(|c| c.is_alphanumeric()).collect()
    };
    let normed: Vec<String> = headers.iter().map(|h| norm(h)).collect();
    let candidates = ["customlabelsku", "customlabel", "sku"];
    let col_idx = candidates
        .iter()
        .find_map(|c| normed.iter().position(|h| h == c));

    let Some(col_idx) = col_idx else {
        return Ok(vec![]);
    };

    let mut samples: Vec<String> = Vec::new();
    for result in rdr.records() {
        if samples.len() >= 8 { break; }
        if let Ok(record) = result {
            if let Some(val) = record.get(col_idx) {
                for sku in val.split(',').map(|s| s.trim()).filter(|s| !s.is_empty()) {
                    if samples.len() >= 8 { break; }
                    let sku = sku.to_string();
                    if !samples.contains(&sku) {
                        samples.push(sku);
                    }
                }
            }
        }
    }

    Ok(samples)
}

#[tauri::command]
fn import_inventory_csv(
    state: tauri::State<'_, Arc<AppState>>,
    path: String,
    schema_id: Option<i64>,
    keep_first_sku: bool,
) -> Result<db::ImportResult, String> {
    let conn = state.db.lock().unwrap();
    let p = std::path::Path::new(&path);
    let filename = p.file_name().unwrap_or_default().to_string_lossy().to_string();
    db::import_inventory(&conn, p, &filename, schema_id, keep_first_sku)
}

#[tauri::command]
fn get_sku_schemas(state: tauri::State<'_, Arc<AppState>>) -> Result<Vec<db::SkuSchema>, String> {
    let conn = state.db.lock().unwrap();
    db::get_schemas(&conn)
}

#[tauri::command]
fn create_sku_schema(
    state: tauri::State<'_, Arc<AppState>>,
    name: String,
    segment_labels: Vec<String>,
) -> Result<db::SkuSchema, String> {
    let conn = state.db.lock().unwrap();
    db::create_schema(&conn, &name, &segment_labels)
}

#[tauri::command]
fn delete_sku_schema(
    state: tauri::State<'_, Arc<AppState>>,
    id: i64,
) -> Result<(), String> {
    let conn = state.db.lock().unwrap();
    db::delete_schema(&conn, id)
}

#[tauri::command]
fn import_orders_csv(
    state: tauri::State<'_, Arc<AppState>>,
    path: String,
) -> Result<db::ImportResult, String> {
    let conn = state.db.lock().unwrap();
    let p = std::path::Path::new(&path);
    let filename = p.file_name().unwrap_or_default().to_string_lossy().to_string();
    db::import_orders(&conn, p, &filename)
}

#[tauri::command]
fn get_inventory_items(
    state: tauri::State<'_, Arc<AppState>>,
    search: String,
    status: String,
) -> Result<Vec<db::InventoryItemRow>, String> {
    let conn = state.db.lock().unwrap();
    db::query_inventory(&conn, &search, &status)
}

#[tauri::command]
fn get_orders_with_items(
    state: tauri::State<'_, Arc<AppState>>,
    status: String,
) -> Result<Vec<db::OrderRow>, String> {
    let conn = state.db.lock().unwrap();
    db::query_orders(&conn, &status)
}

#[tauri::command]
fn mark_order_packed(
    state: tauri::State<'_, Arc<AppState>>,
    order_id: i64,
) -> Result<(), String> {
    let conn = state.db.lock().unwrap();
    db::mark_packed(&conn, order_id)
}

#[tauri::command]
fn get_inventory_stats(
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<db::InventoryStats, String> {
    let conn = state.db.lock().unwrap();
    db::inventory_stats(&conn)
}

#[tauri::command]
fn bulk_delete_inventory_items(
    state: tauri::State<'_, Arc<AppState>>,
    ids: Vec<i64>,
) -> Result<usize, String> {
    let conn = state.db.lock().unwrap();
    let mut count = 0usize;
    for id in &ids {
        conn.execute(
            "UPDATE order_items SET inventory_item_id = NULL WHERE inventory_item_id = ?1",
            rusqlite::params![id],
        ).map_err(|e| e.to_string())?;
        count += conn.execute(
            "DELETE FROM inventory_items WHERE id = ?1",
            rusqlite::params![id],
        ).map_err(|e| e.to_string())?;
    }
    Ok(count)
}

#[tauri::command]
fn bulk_update_inventory_status(
    state: tauri::State<'_, Arc<AppState>>,
    ids: Vec<i64>,
    status: String,
) -> Result<(), String> {
    let conn = state.db.lock().unwrap();
    for id in &ids {
        conn.execute(
            "UPDATE inventory_items SET status = ?1 WHERE id = ?2",
            rusqlite::params![status, id],
        ).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn delete_inventory_item(
    state: tauri::State<'_, Arc<AppState>>,
    id: i64,
) -> Result<(), String> {
    let conn = state.db.lock().unwrap();
    // Clear FK references in order_items before deleting
    conn.execute(
        "UPDATE order_items SET inventory_item_id = NULL WHERE inventory_item_id = ?1",
        rusqlite::params![id],
    ).map_err(|e| e.to_string())?;
    conn.execute(
        "DELETE FROM inventory_items WHERE id = ?1",
        rusqlite::params![id],
    ).map_err(|e| e.to_string())?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Active eBay listings commands
// ---------------------------------------------------------------------------

#[tauri::command]
fn import_active_listings_csv(
    state: tauri::State<'_, Arc<AppState>>,
    path: String,
) -> Result<db::ActiveListingImportResult, String> {
    let conn = state.db.lock().unwrap();
    let p = std::path::Path::new(&path);
    let filename = p.file_name().unwrap_or_default().to_string_lossy().to_string();
    db::import_active_listings(&conn, p, &filename)
}

#[tauri::command]
fn get_active_listings_count(
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<i64, String> {
    let conn = state.db.lock().unwrap();
    db::get_active_listings_count(&conn)
}

#[tauri::command]
fn clear_active_listings(
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<(), String> {
    let conn = state.db.lock().unwrap();
    db::clear_active_listings(&conn)
}

#[tauri::command]
fn get_fulfillments(
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<Vec<db::FulfillmentBatch>, String> {
    let conn = state.db.lock().unwrap();
    db::get_fulfillments(&conn)
}

#[tauri::command]
fn save_fulfillment_times(
    fulfillment_id: i64,
    pick_seconds: i64,
    pack_seconds: i64,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<(), String> {
    let conn = state.db.lock().unwrap();
    db::save_fulfillment_times(&conn, fulfillment_id, pick_seconds, pack_seconds)
}

#[tauri::command]
fn clear_fulfillments(
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<(), String> {
    let conn = state.db.lock().unwrap();
    db::clear_fulfillments(&conn)
}

#[tauri::command]
fn get_pack_orders(
    fulfillment_id: i64,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<Vec<db::PackOrder>, String> {
    let conn = state.db.lock().unwrap();
    db::get_pack_orders(&conn, fulfillment_id)
}

#[tauri::command]
fn get_pick_sheet(
    fulfillment_id: i64,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<Vec<db::PickSheetItem>, String> {
    let conn = state.db.lock().unwrap();
    db::get_pick_sheet(&conn, fulfillment_id)
}

#[tauri::command]
fn get_sync_status(
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<db::SyncStatus, String> {
    let conn = state.db.lock().unwrap();
    db::get_sync_status(&conn)
}

#[tauri::command]
fn print_webview(window: tauri::WebviewWindow) -> Result<(), String> {
    window.print().map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;
            let db_path = data_dir.join("inventory.db");
            let conn = db::init(&db_path)
                .map_err(|e| Box::new(e) as Box<dyn std::error::Error>)?;
            let state = Arc::new(AppState::new(conn));
            app.manage(state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            load_config,
            save_config,
            get_sku_preview,
            select_directory,
            select_file,
            start_watcher,
            stop_watcher,
            process_folder_manual,
            process_all_subfolders,
            test_auth,
            import_inventory_csv,
            import_orders_csv,
            get_inventory_items,
            get_orders_with_items,
            mark_order_packed,
            get_inventory_stats,
            delete_inventory_item,
            bulk_delete_inventory_items,
            bulk_update_inventory_status,
            get_sku_schemas,
            create_sku_schema,
            delete_sku_schema,
            preview_inventory_csv,
            import_active_listings_csv,
            get_active_listings_count,
            clear_active_listings,
            get_sync_status,
            get_fulfillments,
            save_fulfillment_times,
            clear_fulfillments,
            get_pack_orders,
            get_pick_sheet,
            print_webview,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
