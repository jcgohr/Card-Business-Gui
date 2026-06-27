use std::collections::HashMap;
use std::path::Path;

use rusqlite::{params, Connection};
use serde::Serialize;

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const SCHEMA: &str = "
    CREATE TABLE IF NOT EXISTS sku_schemas (
        id             INTEGER PRIMARY KEY,
        name           TEXT NOT NULL UNIQUE,
        segment_labels TEXT NOT NULL DEFAULT '[]',
        created_at     DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS active_ebay_listings (
        id                 INTEGER PRIMARY KEY,
        ebay_item_number   TEXT NOT NULL,
        title              TEXT NOT NULL,
        title_normalized   TEXT NOT NULL,
        custom_label       TEXT,
        available_quantity INTEGER NOT NULL DEFAULT 0,
        format             TEXT,
        condition          TEXT,
        start_price        REAL,
        source_file        TEXT,
        imported_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(ebay_item_number)
    );

    CREATE INDEX IF NOT EXISTS idx_ael_title_norm ON active_ebay_listings(title_normalized);

    CREATE TABLE IF NOT EXISTS inventory_items (
        id           INTEGER PRIMARY KEY,
        title        TEXT NOT NULL,
        card_name    TEXT,
        card_number  TEXT,
        set_name     TEXT,
        rarity       TEXT,
        finish       TEXT,
        specialty    TEXT,
        condition    TEXT,
        price        REAL,
        pic_urls     TEXT,
        illustrator  TEXT,
        year         TEXT,
        stage        TEXT,
        tcg          TEXT,
        custom_label TEXT,
        language     TEXT,
        status       TEXT NOT NULL DEFAULT 'listed',
        source_file  TEXT,
        imported_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
        description  TEXT,
        card_type    TEXT,
        graded       TEXT,
        color        TEXT,
        character    TEXT
    );

    CREATE TABLE IF NOT EXISTS imports (
        id          INTEGER PRIMARY KEY,
        filename    TEXT NOT NULL,
        type        TEXT NOT NULL,
        imported_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        row_count   INTEGER
    );

    CREATE TABLE IF NOT EXISTS orders (
        id                INTEGER PRIMARY KEY,
        ebay_order_number TEXT NOT NULL UNIQUE,
        buyer_username    TEXT,
        buyer_name        TEXT,
        ship_to_name      TEXT,
        ship_to_address1  TEXT,
        ship_to_address2  TEXT,
        ship_to_city      TEXT,
        ship_to_state     TEXT,
        ship_to_zip       TEXT,
        ship_to_country   TEXT,
        sale_date         TEXT,
        paid_on_date      TEXT,
        shipped_on_date   TEXT,
        status            TEXT NOT NULL DEFAULT 'new',
        source_file       TEXT,
        imported_at       DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS order_items (
        id                  INTEGER PRIMARY KEY,
        order_id            INTEGER NOT NULL REFERENCES orders(id),
        sales_record_number TEXT,
        ebay_item_number    TEXT,
        item_title          TEXT,
        custom_label        TEXT,
        quantity            INTEGER DEFAULT 1,
        sold_for            REAL,
        tracking_number     TEXT,
        transaction_id      TEXT,
        inventory_item_id   INTEGER REFERENCES inventory_items(id)
    );

    CREATE INDEX IF NOT EXISTS idx_inv_custom_label ON inventory_items(custom_label);
    CREATE INDEX IF NOT EXISTS idx_oi_custom_label  ON order_items(custom_label);
    CREATE INDEX IF NOT EXISTS idx_orders_ebay_num  ON orders(ebay_order_number);
";

pub fn init(path: &Path) -> rusqlite::Result<Connection> {
    let conn = Connection::open(path)?;
    conn.execute_batch(SCHEMA)?;
    // Migrations for columns added after initial release
    let _ = conn.execute("ALTER TABLE inventory_items ADD COLUMN sku_schema_id INTEGER REFERENCES sku_schemas(id)", []);
    let _ = conn.execute("ALTER TABLE inventory_items ADD COLUMN language TEXT", []);
    let _ = conn.execute("ALTER TABLE inventory_items ADD COLUMN card_type TEXT", []);
    let _ = conn.execute("ALTER TABLE inventory_items ADD COLUMN graded TEXT", []);
    let _ = conn.execute("ALTER TABLE inventory_items ADD COLUMN color TEXT", []);
    let _ = conn.execute("ALTER TABLE inventory_items ADD COLUMN character TEXT", []);
    Ok(conn)
}

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

#[derive(Serialize, Debug, Clone)]
pub struct SkuSchema {
    pub id: i64,
    pub name: String,
    pub segment_labels: Vec<String>,
    pub created_at: String,
}

#[derive(Serialize, Debug, Clone)]
pub struct ImportResult {
    pub rows_imported: usize,
    pub already_existed: usize,
    pub ebay_csv_path: Option<String>,
    pub deduped_count: usize,
    pub revise_rows_added: usize,
}

#[derive(Serialize, Debug, Clone)]
pub struct ActiveListingImportResult {
    pub rows_imported: usize,
    pub rows_replaced: usize,
}

#[derive(Serialize, Debug, Clone)]
pub struct InventoryItemRow {
    pub id: i64,
    pub title: String,
    pub card_name: String,
    pub card_number: String,
    pub set_name: String,
    pub rarity: String,
    pub finish: String,
    pub specialty: String,
    pub condition: String,
    pub price: Option<f64>,
    pub tcg: String,
    pub language: String,
    pub illustrator: String,
    pub year: String,
    pub stage: String,
    pub description: String,
    pub custom_label: String,
    pub status: String,
    pub imported_at: String,
    pub sku_schema_id: Option<i64>,
    pub schema_name: String,
    pub segment_labels: Vec<String>,
    pub pic_urls: Vec<String>,
    pub card_type: String,
    pub graded: String,
    pub color: String,
    pub character: String,
}

#[derive(Serialize, Debug, Clone)]
pub struct OrderItemRow {
    pub id: i64,
    pub ebay_item_number: String,
    pub item_title: String,
    pub custom_label: String,
    pub quantity: i64,
    pub sold_for: Option<f64>,
    pub tracking_number: String,
    pub inventory_item_id: Option<i64>,
    pub inventory_title: String,
}

#[derive(Serialize, Debug, Clone)]
pub struct OrderRow {
    pub id: i64,
    pub ebay_order_number: String,
    pub buyer_username: String,
    pub buyer_name: String,
    pub ship_to_name: String,
    pub ship_to_city: String,
    pub ship_to_state: String,
    pub sale_date: String,
    pub status: String,
    pub items: Vec<OrderItemRow>,
}

#[derive(Serialize, Debug, Clone)]
pub struct InventoryStats {
    pub total: i64,
    pub listed: i64,
    pub sold: i64,
    pub unlisted: i64,
}

// ---------------------------------------------------------------------------
// CSV helpers
// ---------------------------------------------------------------------------

fn col(headers: &[String], candidates: &[&str]) -> Option<usize> {
    let norm = |s: &str| -> String {
        let lower = s.to_lowercase();
        // Strip eBay column prefixes before comparing:
        //   *C:  — category-specific item specifics (e.g. "*C:Card Name")
        //   P:   — item specifics in File Exchange format (e.g. "P:Card Name")
        //   *    — required-field marker on standard columns (e.g. "*Title")
        let stripped = if lower.starts_with("*c:") {
            &lower[3..]
        } else if lower.starts_with("c:") {
            &lower[2..]
        } else if lower.starts_with("p:") {
            &lower[2..]
        } else if lower.starts_with('*') {
            &lower[1..]
        } else {
            &lower
        };
        stripped.chars().filter(|c| c.is_alphanumeric()).collect()
    };
    let normed: Vec<String> = headers.iter().map(|h| norm(h)).collect();
    candidates
        .iter()
        .find_map(|c| normed.iter().position(|h| h == &norm(c)))
}

fn get(record: &csv::StringRecord, idx: Option<usize>) -> String {
    idx.and_then(|i| record.get(i))
        .unwrap_or("")
        .trim()
        .to_string()
}

fn opt(s: String) -> Option<String> {
    if s.is_empty() { None } else { Some(s) }
}

fn parse_price(s: &str) -> Option<f64> {
    s.trim().trim_start_matches('$').replace(',', "").parse().ok()
}

fn strip_bom(data: Vec<u8>) -> Vec<u8> {
    if data.starts_with(&[0xEF, 0xBB, 0xBF]) {
        data[3..].to_vec()
    } else {
        data
    }
}

// ---------------------------------------------------------------------------
// Inventory CSV import
// ---------------------------------------------------------------------------

pub fn import_inventory(conn: &Connection, path: &Path, filename: &str, schema_id: Option<i64>, keep_first_sku: bool) -> Result<ImportResult, String> {
    let raw = std::fs::read(path).map_err(|e| e.to_string())?;
    let data = strip_bom(raw);
    let mut rdr = csv::Reader::from_reader(data.as_slice());

    let headers: Vec<String> = rdr
        .headers()
        .map_err(|e| e.to_string())?
        .iter()
        .map(|s| s.to_string())
        .collect();

    let c_title        = col(&headers, &["title", "item title"]);
    let c_card_name    = col(&headers, &["card name", "cardname"]);
    let c_card_number  = col(&headers, &["card number", "cardnumber", "number", "card no", "cardno"]);
    let c_set_name     = col(&headers, &["set name", "setname", "set name/number", "setnamenumber", "set"]);
    let c_rarity       = col(&headers, &["rarity"]);
    let c_finish       = col(&headers, &["finish"]);
    let c_specialty    = col(&headers, &["specialty", "speciality"]);
    let c_condition    = col(&headers, &["condition", "condition name", "conditionname", "card condition"]);
    let c_price        = col(&headers, &["start price", "buy it now price", "buyitnowprice", "price"]);
    let c_pic_urls     = col(&headers, &["pic url", "pic urls", "picurl", "picture url", "gallery url", "photo url"]);
    let c_illustrator  = col(&headers, &["illustrator", "artist"]);
    let c_year         = col(&headers, &["year", "release year", "year manufactured"]);
    let c_stage        = col(&headers, &["stage", "evolution stage"]);
    let c_tcg          = col(&headers, &["tcg", "game", "card game"]);
    let c_language     = col(&headers, &["language", "lang", "edition"]);
    let c_custom_label = col(&headers, &["custom label (sku)", "custom label", "customlabelsku", "customlabel", "sku", "seller sku"]);
    let c_description  = col(&headers, &["description"]);
    let c_card_type    = col(&headers, &["card type", "cardtype"]);
    let c_graded       = col(&headers, &["graded"]);
    let c_color        = col(&headers, &["attribute/mtg:colour", "colour", "color", "attribute"]);
    let c_character    = col(&headers, &["character"]);

    if c_title.is_none() {
        return Err("CSV is missing a Title column".into());
    }

    // Buffer all records so we can (1) rewrite the original file and (2) import to DB
    let all_records: Vec<csv::StringRecord> = rdr
        .records()
        .collect::<Result<_, _>>()
        .map_err(|e| e.to_string())?;

    // Load active listings for duplicate detection: norm_title → (item_number, available_qty)
    let active_listings: HashMap<String, (String, i64)> = {
        let mut stmt = conn.prepare(
            "SELECT title_normalized, ebay_item_number, available_quantity FROM active_ebay_listings"
        ).map_err(|e| e.to_string())?;
        let rows: Vec<(String, String, i64)> = stmt
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, i64>(2)?))
            })
            .map_err(|e| e.to_string())?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|e| e.to_string())?;
        rows.into_iter()
            .map(|(norm, item_num, qty)| (norm, (item_num, qty)))
            .collect()
    };

    let has_active = !active_listings.is_empty();

    // Determine which extra columns we need to inject for Revise rows
    let c_action_orig  = col(&headers, &["action"]);
    let c_item_id_orig = col(&headers, &["itemid", "item id"]);
    let c_qty_orig     = col(&headers, &["quantity"]);

    let needs_action_col   = has_active && c_action_orig.is_none();
    let needs_item_id_col  = has_active && c_item_id_orig.is_none();
    let needs_qty_col      = has_active && c_qty_orig.is_none();

    // *Action goes first (eBay File Exchange convention), then original headers, then ItemID/Quantity appended.
    let mut out_headers: Vec<String> = Vec::new();
    if needs_action_col   { out_headers.push("*Action".to_string()); }
    out_headers.extend(headers.iter().cloned());
    if needs_item_id_col  { out_headers.push("ItemID".to_string()); }
    if needs_qty_col      { out_headers.push("*Quantity".to_string()); }

    let c_action_out  = if has_active { col(&out_headers, &["action"]) }  else { None };
    let c_item_id_out = if has_active { col(&out_headers, &["itemid", "item id"]) } else { None };
    let c_qty_out     = if has_active { col(&out_headers, &["quantity"]) } else { None };
    // When *Action was prepended, every original column index shifts by 1.
    let orig_offset: usize = if needs_action_col { 1 } else { 0 };

    // dedup_revise: norm_title → (item_number, avail_qty, new_sku_count, display_title)
    let mut dedup_revise: HashMap<String, (String, i64, usize, String)> = HashMap::new();

    // Overwrite the original CSV with CustomLabel cleared and comma-separated SKUs
    // expanded into individual rows — ready to upload directly to eBay.
    // Duplicate titles (matching active_ebay_listings) are pulled out and written
    // as Revise rows that update the existing listing's quantity instead.
    {
        let mut wtr = csv::Writer::from_path(path).map_err(|e| e.to_string())?;
        wtr.write_record(&out_headers).map_err(|e| e.to_string())?;

        for record in &all_records {
            let title = get(record, c_title);
            if title.is_empty() { continue; }
            let norm_title = title.trim().to_lowercase();

            if let Some((item_number, avail_qty)) = active_listings.get(&norm_title) {
                // Count how many physical SKUs this row represents
                let raw_label = get(record, c_custom_label);
                let sku_count = if raw_label.is_empty() { 1 } else {
                    raw_label.split(',').filter(|s| !s.trim().is_empty()).count().max(1)
                };
                let entry = dedup_revise
                    .entry(norm_title)
                    .or_insert((item_number.clone(), *avail_qty, 0, title.clone()));
                entry.2 += sku_count;
                continue; // don't emit a new-listing row for this title
            }

            let raw_label = get(record, c_custom_label);
            let sku_count = if raw_label.is_empty() {
                1
            } else {
                raw_label.split(',').filter(|s| !s.trim().is_empty()).count().max(1)
            };
            let first_sku = raw_label.split(',').next().unwrap_or("").trim().to_string();

            for row_idx in 0..sku_count {
                let label_val = if keep_first_sku && row_idx == 0 {
                    first_sku.clone()
                } else {
                    String::new()
                };
                let mut fields: Vec<String> = Vec::with_capacity(out_headers.len());
                // Prepend Action=Add if we added the column (so it stays first)
                if needs_action_col { fields.push("Add".to_string()); }
                // Original record fields (clearing custom_label)
                for (i, s) in record.iter().enumerate() {
                    if Some(i) == c_custom_label {
                        fields.push(label_val.clone());
                    } else {
                        fields.push(s.to_string());
                    }
                }
                // If Action column already existed in original but is blank, set Add
                if let Some(idx) = c_action_orig {
                    if fields.get(idx).map(|s| s.is_empty()).unwrap_or(false) {
                        fields[idx] = "Add".to_string();
                    }
                }
                // Append remaining new columns
                if needs_item_id_col  { fields.push(String::new()); }
                if needs_qty_col      { fields.push("1".to_string()); }
                wtr.write_record(&fields).map_err(|e| e.to_string())?;
            }
        }

        // Append one Revise row per deduplicated title
        for (_, (item_number, avail_qty, new_count, display_title)) in &dedup_revise {
            let total_qty = avail_qty + *new_count as i64;
            let mut fields: Vec<String> = vec![String::new(); out_headers.len()];
            if let Some(idx) = c_action_out  { fields[idx] = "Revise".to_string(); }
            if let Some(idx) = c_item_id_out { fields[idx] = item_number.clone(); }
            if let Some(idx) = c_qty_out     { fields[idx] = total_qty.to_string(); }
            // c_title is an index into the original headers; shift by orig_offset in output
            if let Some(orig_idx) = c_title  { fields[orig_idx + orig_offset] = display_title.clone(); }
            wtr.write_record(&fields).map_err(|e| e.to_string())?;
        }

        wtr.flush().map_err(|e| e.to_string())?;
    }

    let deduped_count: usize = dedup_revise.values().map(|v| v.2).sum();
    let revise_rows_added: usize = dedup_revise.len();

    let mut rows_imported = 0usize;

    for record in all_records {
        let title = get(&record, c_title);
        if title.is_empty() {
            continue;
        }

        // Split comma-separated custom labels — one listing may cover multiple
        // physical cards each with their own SKU (e.g. "fb1-1-1-3, fb1-1-1-4").
        // Each SKU becomes its own inventory row so it can be fulfilled individually.
        let raw_label = get(&record, c_custom_label);
        let skus: Vec<Option<String>> = if raw_label.is_empty() {
            vec![None]
        } else {
            let parts: Vec<String> = raw_label
                .split(',')
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect();
            parts.into_iter().map(Some).collect()
        };

        // Shared fields for this listing row
        let card_name   = opt(get(&record, c_card_name));
        let card_number = opt(get(&record, c_card_number));
        let set_name    = opt(get(&record, c_set_name));
        let rarity      = opt(get(&record, c_rarity));
        let finish      = opt(get(&record, c_finish));
        let specialty   = opt(get(&record, c_specialty));
        let condition   = opt(get(&record, c_condition).trim_end_matches(':').trim().to_string());
        let price       = parse_price(&get(&record, c_price));
        let pic_urls    = opt(get(&record, c_pic_urls));
        let illustrator = opt(get(&record, c_illustrator));
        let year        = opt(get(&record, c_year));
        let stage       = opt(get(&record, c_stage));
        let tcg         = opt(get(&record, c_tcg));
        let language    = opt(get(&record, c_language));
        let description = opt(get(&record, c_description));
        let card_type   = opt(get(&record, c_card_type));
        let graded      = opt(get(&record, c_graded));
        let color       = opt(get(&record, c_color));
        let character   = opt(get(&record, c_character));

        for sku in skus {
            conn.execute(
                "INSERT INTO inventory_items (
                    title, card_name, card_number, set_name, rarity, finish, specialty,
                    condition, price, pic_urls, illustrator, year, stage, tcg,
                    language, custom_label, description, source_file, sku_schema_id,
                    card_type, graded, color, character
                 ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22,?23)",
                params![
                    title,
                    card_name,
                    card_number,
                    set_name,
                    rarity,
                    finish,
                    specialty,
                    condition,
                    price,
                    pic_urls,
                    illustrator,
                    year,
                    stage,
                    tcg,
                    language,
                    sku,
                    description,
                    filename,
                    schema_id,
                    card_type,
                    graded,
                    color,
                    character,
                ],
            ).map_err(|e| e.to_string())?;
            rows_imported += 1;
        }
    }

    conn.execute(
        "INSERT INTO imports (filename, type, row_count) VALUES (?1, 'inventory', ?2)",
        params![filename, rows_imported as i64],
    ).map_err(|e| e.to_string())?;

    Ok(ImportResult { rows_imported, already_existed: 0, ebay_csv_path: None, deduped_count, revise_rows_added })
}

// ---------------------------------------------------------------------------
// Orders CSV import
// ---------------------------------------------------------------------------
//
// eBay order export multi-row format:
//   For multi-item orders the first row has buyer/shipping info but no item
//   fields (Item Number is empty). Subsequent rows carry item data but no
//   buyer info. Single-item orders have everything on one row.
//   We group rows by Order Number; orders are deduplicated by ebay_order_number.

pub fn import_orders(conn: &Connection, path: &Path, filename: &str) -> Result<ImportResult, String> {
    let raw = std::fs::read(path).map_err(|e| e.to_string())?;
    let data = strip_bom(raw);
    let mut rdr = csv::ReaderBuilder::new()
        .flexible(true)
        .from_reader(data.as_slice());

    let headers: Vec<String> = rdr
        .headers()
        .map_err(|e| e.to_string())?
        .iter()
        .map(|s| s.to_string())
        .collect();

    let c_order_number   = col(&headers, &["order number"]);
    let c_sales_record   = col(&headers, &["sales record number"]);
    let c_buyer_username = col(&headers, &["buyer username"]);
    let c_buyer_name     = col(&headers, &["buyer name"]);
    let c_ship_name      = col(&headers, &["ship to name"]);
    let c_ship_addr1     = col(&headers, &["ship to address 1", "ship to address1"]);
    let c_ship_addr2     = col(&headers, &["ship to address 2", "ship to address2"]);
    let c_ship_city      = col(&headers, &["ship to city"]);
    let c_ship_state     = col(&headers, &["ship to state"]);
    let c_ship_zip       = col(&headers, &["ship to zip"]);
    let c_ship_country   = col(&headers, &["ship to country"]);
    let c_item_number    = col(&headers, &["item number"]);
    let c_item_title     = col(&headers, &["item title"]);
    let c_custom_label   = col(&headers, &["custom label"]);
    let c_quantity       = col(&headers, &["quantity"]);
    let c_sold_for       = col(&headers, &["sold for"]);
    let c_sale_date      = col(&headers, &["sale date"]);
    let c_paid_date      = col(&headers, &["paid on date"]);
    let c_shipped_date   = col(&headers, &["shipped on date"]);
    let c_tracking       = col(&headers, &["tracking number"]);
    let c_transaction_id = col(&headers, &["transaction id"]);

    if c_order_number.is_none() {
        return Err("CSV is missing an Order Number column".into());
    }

    // order_number → (db_id, is_new)
    let mut order_map: HashMap<String, (i64, bool)> = HashMap::new();
    let mut rows_imported = 0usize;
    let mut already_existed = 0usize;

    for result in rdr.records() {
        let record = result.map_err(|e| e.to_string())?;
        let order_number = get(&record, c_order_number);
        if order_number.is_empty() {
            continue;
        }

        // --- Ensure order row exists -----------------------------------------
        let (order_id, is_new) = if let Some(&cached) = order_map.get(&order_number) {
            cached
        } else {
            let affected = conn.execute(
                "INSERT OR IGNORE INTO orders (
                    ebay_order_number, buyer_username, buyer_name,
                    ship_to_name, ship_to_address1, ship_to_address2,
                    ship_to_city, ship_to_state, ship_to_zip, ship_to_country,
                    sale_date, paid_on_date, shipped_on_date, source_file
                 ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14)",
                params![
                    order_number,
                    opt(get(&record, c_buyer_username)),
                    opt(get(&record, c_buyer_name)),
                    opt(get(&record, c_ship_name)),
                    opt(get(&record, c_ship_addr1)),
                    opt(get(&record, c_ship_addr2)),
                    opt(get(&record, c_ship_city)),
                    opt(get(&record, c_ship_state)),
                    opt(get(&record, c_ship_zip)),
                    opt(get(&record, c_ship_country)),
                    opt(get(&record, c_sale_date)),
                    opt(get(&record, c_paid_date)),
                    opt(get(&record, c_shipped_date)),
                    filename,
                ],
            ).map_err(|e| e.to_string())?;

            let new = affected > 0;
            if !new {
                already_existed += 1;
            }

            let id: i64 = conn
                .query_row(
                    "SELECT id FROM orders WHERE ebay_order_number = ?1",
                    params![order_number],
                    |row| row.get(0),
                )
                .map_err(|e| e.to_string())?;

            order_map.insert(order_number.clone(), (id, new));
            (id, new)
        };

        // --- Add item if row has item data ------------------------------------
        let item_number = get(&record, c_item_number);
        let item_title  = get(&record, c_item_title);

        if item_number.is_empty() && item_title.is_empty() {
            continue; // order header row with no item — skip
        }

        // Skip items for duplicate orders to avoid re-inserting on reimport
        if !is_new {
            continue;
        }

        let custom_label   = get(&record, c_custom_label);
        let quantity: i64  = get(&record, c_quantity).parse().unwrap_or(1);
        let sold_for       = parse_price(&get(&record, c_sold_for));
        let tracking       = get(&record, c_tracking);
        let transaction_id = get(&record, c_transaction_id);
        let sales_record   = get(&record, c_sales_record);

        // Try to link to an unlisted/listed inventory item with matching SKU
        let inventory_item_id: Option<i64> = if !custom_label.is_empty() {
            conn.query_row(
                "SELECT id FROM inventory_items WHERE custom_label = ?1 AND status != 'sold' LIMIT 1",
                params![custom_label],
                |row| row.get(0),
            ).ok()
        } else {
            None
        };

        conn.execute(
            "INSERT INTO order_items (
                order_id, sales_record_number, ebay_item_number, item_title,
                custom_label, quantity, sold_for, tracking_number,
                transaction_id, inventory_item_id
             ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",
            params![
                order_id,
                opt(sales_record),
                opt(item_number),
                opt(item_title),
                opt(custom_label),
                quantity,
                sold_for,
                opt(tracking),
                opt(transaction_id),
                inventory_item_id,
            ],
        ).map_err(|e| e.to_string())?;

        rows_imported += 1;
    }

    conn.execute(
        "INSERT INTO imports (filename, type, row_count) VALUES (?1, 'orders', ?2)",
        params![filename, rows_imported as i64],
    ).map_err(|e| e.to_string())?;

    Ok(ImportResult { rows_imported, already_existed, ebay_csv_path: None, deduped_count: 0, revise_rows_added: 0 })
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

pub fn query_inventory(
    conn: &Connection,
    search: &str,
    status_filter: &str,
) -> Result<Vec<InventoryItemRow>, String> {
    let like = format!("%{}%", search);
    let mut stmt = conn
        .prepare(
            "SELECT i.id, i.title,
                COALESCE(i.card_name,''), COALESCE(i.card_number,''),
                COALESCE(i.set_name,''), COALESCE(i.rarity,''),
                COALESCE(i.finish,''), COALESCE(i.specialty,''),
                COALESCE(i.condition,''), i.price,
                COALESCE(i.tcg,''), COALESCE(i.language,''),
                COALESCE(i.illustrator,''), COALESCE(i.year,''),
                COALESCE(i.stage,''), COALESCE(i.description,''),
                COALESCE(i.custom_label,''), i.status, i.imported_at,
                i.sku_schema_id, COALESCE(s.name,''), COALESCE(s.segment_labels,'[]'),
                COALESCE(i.pic_urls,''),
                COALESCE(i.card_type,''), COALESCE(i.graded,''),
                COALESCE(i.color,''), COALESCE(i.character,'')
             FROM inventory_items i
             LEFT JOIN sku_schemas s ON s.id = i.sku_schema_id
             WHERE (i.title LIKE ?1 OR i.card_name LIKE ?1 OR i.custom_label LIKE ?1 OR i.set_name LIKE ?1)
               AND (?2 = '' OR i.status = ?2)
             ORDER BY i.id DESC
             LIMIT 500",
        )
        .map_err(|e| e.to_string())?;

    let rows = stmt
        .query_map(params![like, status_filter], |row| {
            let labels_json: String = row.get(21)?;
            let segment_labels: Vec<String> =
                serde_json::from_str(&labels_json).unwrap_or_default();
            let pic_urls_raw: String = row.get(22)?;
            let pic_urls: Vec<String> = pic_urls_raw
                .split('|')
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect();
            Ok(InventoryItemRow {
                id:          row.get(0)?,
                title:       row.get(1)?,
                card_name:   row.get(2)?,
                card_number: row.get(3)?,
                set_name:    row.get(4)?,
                rarity:      row.get(5)?,
                finish:      row.get(6)?,
                specialty:   row.get(7)?,
                condition:   row.get(8)?,
                price:       row.get(9)?,
                tcg:         row.get(10)?,
                language:    row.get(11)?,
                illustrator: row.get(12)?,
                year:        row.get(13)?,
                stage:       row.get(14)?,
                description: row.get(15)?,
                custom_label: row.get(16)?,
                status:       row.get(17)?,
                imported_at:  row.get(18)?,
                sku_schema_id: row.get(19)?,
                schema_name:   row.get(20)?,
                segment_labels,
                pic_urls,
                card_type:  row.get(23)?,
                graded:     row.get(24)?,
                color:      row.get(25)?,
                character:  row.get(26)?,
            })
        })
        .map_err(|e| e.to_string())?;

    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())
}

pub fn query_orders(
    conn: &Connection,
    status_filter: &str,
) -> Result<Vec<OrderRow>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, ebay_order_number,
                COALESCE(buyer_username,''), COALESCE(buyer_name,''),
                COALESCE(ship_to_name,''), COALESCE(ship_to_city,''),
                COALESCE(ship_to_state,''), COALESCE(sale_date,''),
                status
             FROM orders
             WHERE (?1 = '' OR status = ?1)
             ORDER BY id DESC
             LIMIT 500",
        )
        .map_err(|e| e.to_string())?;

    let mut orders = stmt
        .query_map(params![status_filter], |row| {
            Ok(OrderRow {
                id: row.get(0)?,
                ebay_order_number: row.get(1)?,
                buyer_username: row.get(2)?,
                buyer_name: row.get(3)?,
                ship_to_name: row.get(4)?,
                ship_to_city: row.get(5)?,
                ship_to_state: row.get(6)?,
                sale_date: row.get(7)?,
                status: row.get(8)?,
                items: vec![],
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())?;

    let mut item_stmt = conn
        .prepare(
            "SELECT oi.id,
                COALESCE(oi.ebay_item_number,''), COALESCE(oi.item_title,''),
                COALESCE(oi.custom_label,''), oi.quantity, oi.sold_for,
                COALESCE(oi.tracking_number,''), oi.inventory_item_id,
                COALESCE(inv.title,'')
             FROM order_items oi
             LEFT JOIN inventory_items inv ON inv.id = oi.inventory_item_id
             WHERE oi.order_id = ?1
             ORDER BY oi.id",
        )
        .map_err(|e| e.to_string())?;

    for order in &mut orders {
        order.items = item_stmt
            .query_map(params![order.id], |row| {
                Ok(OrderItemRow {
                    id: row.get(0)?,
                    ebay_item_number: row.get(1)?,
                    item_title: row.get(2)?,
                    custom_label: row.get(3)?,
                    quantity: row.get(4)?,
                    sold_for: row.get(5)?,
                    tracking_number: row.get(6)?,
                    inventory_item_id: row.get(7)?,
                    inventory_title: row.get(8)?,
                })
            })
            .map_err(|e| e.to_string())?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|e| e.to_string())?;
    }

    Ok(orders)
}

pub fn inventory_stats(conn: &Connection) -> Result<InventoryStats, String> {
    let count = |sql: &str| -> Result<i64, String> {
        conn.query_row(sql, [], |r| r.get(0))
            .map_err(|e| e.to_string())
    };
    Ok(InventoryStats {
        total:    count("SELECT COUNT(*) FROM inventory_items")?,
        listed:   count("SELECT COUNT(*) FROM inventory_items WHERE status = 'listed'")?,
        sold:     count("SELECT COUNT(*) FROM inventory_items WHERE status = 'sold'")?,
        unlisted: count("SELECT COUNT(*) FROM inventory_items WHERE status = 'unlisted'")?,
    })
}

// ---------------------------------------------------------------------------
// SKU Schema management
// ---------------------------------------------------------------------------

pub fn get_schemas(conn: &Connection) -> Result<Vec<SkuSchema>, String> {
    let mut stmt = conn
        .prepare("SELECT id, name, segment_labels, created_at FROM sku_schemas ORDER BY name")
        .map_err(|e| e.to_string())?;

    let rows = stmt
        .query_map([], |row| {
            let labels_json: String = row.get(2)?;
            Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?, labels_json, row.get::<_, String>(3)?))
        })
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())?;

    Ok(rows.into_iter().map(|(id, name, labels_json, created_at)| {
        let segment_labels = serde_json::from_str(&labels_json).unwrap_or_default();
        SkuSchema { id, name, segment_labels, created_at }
    }).collect())
}

pub fn create_schema(conn: &Connection, name: &str, segment_labels: &[String]) -> Result<SkuSchema, String> {
    let labels_json = serde_json::to_string(segment_labels).map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO sku_schemas (name, segment_labels) VALUES (?1, ?2)",
        params![name, labels_json],
    ).map_err(|e| e.to_string())?;
    let id = conn.last_insert_rowid();
    let created_at: String = conn
        .query_row("SELECT created_at FROM sku_schemas WHERE id = ?1", params![id], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    Ok(SkuSchema { id, name: name.to_string(), segment_labels: segment_labels.to_vec(), created_at })
}

pub fn delete_schema(conn: &Connection, id: i64) -> Result<(), String> {
    // Detach items before deleting
    conn.execute("UPDATE inventory_items SET sku_schema_id = NULL WHERE sku_schema_id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM sku_schemas WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Active eBay listings store
// ---------------------------------------------------------------------------

pub fn import_active_listings(conn: &Connection, path: &Path, filename: &str) -> Result<ActiveListingImportResult, String> {
    let raw = std::fs::read(path).map_err(|e| e.to_string())?;
    let data = strip_bom(raw);
    let mut rdr = csv::Reader::from_reader(data.as_slice());

    let headers: Vec<String> = rdr
        .headers()
        .map_err(|e| e.to_string())?
        .iter()
        .map(|s| s.to_string())
        .collect();

    let c_item_number = col(&headers, &["item number", "itemnumber", "item no"]);
    let c_title       = col(&headers, &["title"]);
    let c_custom_label = col(&headers, &["custom label (sku)", "custom label", "customlabelsku", "customlabel", "sku"]);
    let c_avail_qty   = col(&headers, &["available quantity", "availablequantity", "quantity"]);
    let c_format      = col(&headers, &["format"]);
    let c_condition   = col(&headers, &["condition"]);
    let c_start_price = col(&headers, &["start price", "startprice"]);

    if c_item_number.is_none() {
        return Err("CSV is missing an 'Item number' column — upload the eBay active listings report".into());
    }
    if c_title.is_none() {
        return Err("CSV is missing a Title column".into());
    }

    let mut rows_imported = 0usize;

    for result in rdr.records() {
        let record = result.map_err(|e| e.to_string())?;
        let item_number = get(&record, c_item_number);
        let title = get(&record, c_title);
        if item_number.is_empty() || title.is_empty() { continue; }

        let title_normalized = title.trim().to_lowercase();
        let custom_label = opt(get(&record, c_custom_label));
        let avail_qty: i64 = get(&record, c_avail_qty)
            .trim().parse::<f64>().map(|f| f as i64).unwrap_or(0);
        let format    = opt(get(&record, c_format));
        let condition = opt(get(&record, c_condition));
        let start_price = parse_price(&get(&record, c_start_price));

        conn.execute(
            "INSERT INTO active_ebay_listings (
                 ebay_item_number, title, title_normalized, custom_label,
                 available_quantity, format, condition, start_price, source_file
             ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)
             ON CONFLICT(ebay_item_number) DO UPDATE SET
                 title              = excluded.title,
                 title_normalized   = excluded.title_normalized,
                 custom_label       = excluded.custom_label,
                 available_quantity = excluded.available_quantity,
                 format             = excluded.format,
                 condition          = excluded.condition,
                 start_price        = excluded.start_price,
                 source_file        = excluded.source_file,
                 imported_at        = CURRENT_TIMESTAMP",
            params![
                item_number,
                title,
                title_normalized,
                custom_label,
                avail_qty,
                format,
                condition,
                start_price,
                filename,
            ],
        ).map_err(|e| e.to_string())?;

        rows_imported += 1;
    }

    conn.execute(
        "INSERT INTO imports (filename, type, row_count) VALUES (?1, 'active_listings', ?2)",
        params![filename, rows_imported as i64],
    ).map_err(|e| e.to_string())?;

    Ok(ActiveListingImportResult { rows_imported, rows_replaced: 0 })
}

pub fn get_active_listings_count(conn: &Connection) -> Result<i64, String> {
    conn.query_row("SELECT COUNT(*) FROM active_ebay_listings", [], |r| r.get(0))
        .map_err(|e| e.to_string())
}

pub fn clear_active_listings(conn: &Connection) -> Result<(), String> {
    conn.execute("DELETE FROM active_ebay_listings", [])
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[derive(Serialize, Debug, Clone)]
pub struct SyncStatus {
    /// When the active listings snapshot was last loaded (ISO datetime or empty string).
    pub last_active_at: String,
    /// How many inventory CSV imports have happened since the last active listings load.
    /// Any value > 0 means the active listings snapshot may be missing recently uploaded cards.
    pub inventory_imports_since_active: i64,
}

pub fn get_sync_status(conn: &Connection) -> Result<SyncStatus, String> {
    let last_active_at: String = conn.query_row(
        "SELECT COALESCE(MAX(imported_at), '') FROM imports WHERE type = 'active_listings'",
        [],
        |r| r.get(0),
    ).map_err(|e| e.to_string())?;

    let inventory_imports_since_active: i64 = if last_active_at.is_empty() {
        0
    } else {
        conn.query_row(
            "SELECT COUNT(*) FROM imports WHERE type = 'inventory' AND imported_at > ?1",
            params![last_active_at],
            |r| r.get(0),
        ).map_err(|e| e.to_string())?
    };

    Ok(SyncStatus { last_active_at, inventory_imports_since_active })
}

pub fn mark_packed(conn: &Connection, order_id: i64) -> Result<(), String> {
    conn.execute(
        "UPDATE orders SET status = 'packed' WHERE id = ?1",
        params![order_id],
    ).map_err(|e| e.to_string())?;

    conn.execute(
        "UPDATE inventory_items SET status = 'sold'
         WHERE id IN (
             SELECT inventory_item_id FROM order_items
             WHERE order_id = ?1 AND inventory_item_id IS NOT NULL
         )",
        params![order_id],
    ).map_err(|e| e.to_string())?;

    Ok(())
}
