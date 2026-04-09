#!/usr/bin/env bash
# Bootstrap script for a fresh Ubuntu EC2 t3.micro running Toptier AI OCR.
# Run as the default ubuntu user. Idempotent — safe to re-run.
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/ksmaster03/toptierocr.git}"
APP_DIR="${APP_DIR:-/home/ubuntu/toptierocr}"

echo "==> 1. apt update + base packages"
sudo apt-get update -y
sudo apt-get install -y ca-certificates curl gnupg git ufw

echo "==> 2. install Docker engine + compose plugin"
if ! command -v docker >/dev/null 2>&1; then
  sudo install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  sudo chmod a+r /etc/apt/keyrings/docker.gpg
  echo \
    "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
https://download.docker.com/linux/ubuntu $(. /etc/os-release; echo "$VERSION_CODENAME") stable" | \
    sudo tee /etc/apt/sources.list.d/docker.list >/dev/null
  sudo apt-get update -y
  sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  sudo usermod -aG docker ubuntu
fi

echo "==> 3. swap (4G) — t3.micro has only 1G RAM"
if ! sudo swapon --show | grep -q /swapfile; then
  sudo fallocate -l 4G /swapfile
  sudo chmod 600 /swapfile
  sudo mkswap /swapfile
  sudo swapon /swapfile
  echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
fi

echo "==> 4. clone or pull repo"
if [ -d "$APP_DIR/.git" ]; then
  cd "$APP_DIR" && git pull --ff-only
else
  git clone "$REPO_URL" "$APP_DIR"
fi

echo "==> 5. ensure .env exists (operator must edit before first up)"
if [ ! -f "$APP_DIR/.env" ]; then
  cp "$APP_DIR/.env.production.example" "$APP_DIR/.env"
  chmod 600 "$APP_DIR/.env"
  echo "  ⚠ Created $APP_DIR/.env from template — edit it (DB passwords, MASTER_KEY_BASE64, CLOUDFLARED_TUNNEL_TOKEN) and re-run this script."
  exit 0
fi

echo "==> 6. docker compose up"
cd "$APP_DIR"
sudo -E docker compose -f docker-compose.prod.yml --env-file .env pull || true
sudo -E docker compose -f docker-compose.prod.yml --env-file .env up -d --build

echo "==> 7. wait for SeekDB then bootstrap database"
sleep 60
DB_ROOT_PASSWORD=$(grep '^DB_ROOT_PASSWORD=' .env | cut -d= -f2- | tr -d '"')
DB_USER=$(grep '^DB_USER=' .env | cut -d= -f2- | tr -d '"')
DB_PASSWORD=$(grep '^DB_PASSWORD=' .env | cut -d= -f2- | tr -d '"')
DB_NAME=$(grep '^DB_NAME=' .env | cut -d= -f2- | tr -d '"')

# Set root password (only effective the first time SeekDB boots)
sudo docker exec tocr-seekdb mysql -h127.0.0.1 -P2881 -uroot -e \
  "ALTER USER 'root' IDENTIFIED BY '${DB_ROOT_PASSWORD}';" 2>/dev/null || true

# Create app user + DB
sudo docker exec tocr-seekdb mysql -h127.0.0.1 -P2881 -uroot -p"${DB_ROOT_PASSWORD}" -e "
  CREATE DATABASE IF NOT EXISTS ${DB_NAME};
  CREATE USER IF NOT EXISTS '${DB_USER}' IDENTIFIED BY '${DB_PASSWORD}';
  GRANT ALL PRIVILEGES ON ${DB_NAME}.* TO '${DB_USER}';
"

echo "==> 8. push schema + seed (runs inside the app container)"
sudo docker exec -e DB_PASSWORD="${DB_PASSWORD}" tocr-app bun x drizzle-kit push --force || true
sudo docker exec tocr-app bun run src/db/seed.ts || true

# Run the additional raw-SQL tables (vendors, POs, GR, doc_types, cost_settings, posting_logs, …)
sudo docker exec tocr-seekdb mysql -h127.0.0.1 -P2881 -uroot -p"${DB_ROOT_PASSWORD}" "${DB_NAME}" <<'SQL'
CREATE TABLE IF NOT EXISTS document_types (
  id INT NOT NULL AUTO_INCREMENT, tenant_id INT NOT NULL,
  code VARCHAR(32) NOT NULL, name VARCHAR(128) NOT NULL,
  description TEXT, icon VARCHAR(64) NOT NULL DEFAULT 'description',
  monthly_volume_label VARCHAR(64), flow_description TEXT,
  output_target VARCHAR(64),
  active TINYINT NOT NULL DEFAULT 1, sort_order INT NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id), UNIQUE KEY document_types_tenant_code_uq (tenant_id, code)
);
INSERT IGNORE INTO document_types (tenant_id, code, name, description, icon, monthly_volume_label, flow_description, output_target, sort_order)
VALUES
  (1, 'stock', 'Stock in Material', 'วัสดุคงคลัง', 'inventory_2', '5,000 inv/เดือน',
     'OCR → AI Match → Export Excel/CSV → Upload SAP Account Payable / Stock', 'sap-stock', 1),
  (1, 'gp', 'GP (General Purchase)', 'จัดซื้อทั่วไป', 'work', '2,500 inv/เดือน',
     'OCR → AI Match & Flag Mismatches → Post AP / Expense in SAP', 'sap-gp', 2),
  (1, 'tx', 'Transaction', 'รายการธุรกรรม', 'credit_card', '400 inv/เดือน',
     'OCR → AI Match & Flag Mismatches → Post AP in SAP', 'sap-tx', 3);

CREATE TABLE IF NOT EXISTS cost_settings (
  id INT NOT NULL AUTO_INCREMENT, tenant_id INT NOT NULL,
  usd_to_thb DECIMAL(8,4) NOT NULL DEFAULT 36.0000,
  ocr_input_tokens_per_page INT NOT NULL DEFAULT 1500,
  ocr_output_tokens_per_page INT NOT NULL DEFAULT 600,
  matching_input_tokens INT NOT NULL DEFAULT 1200,
  matching_output_tokens INT NOT NULL DEFAULT 400,
  pages_per_file DECIMAL(4,2) NOT NULL DEFAULT 1.50,
  matching_provider_id VARCHAR(64),
  provider_overrides TEXT,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id), UNIQUE KEY cost_settings_tenant_uq (tenant_id)
);
INSERT IGNORE INTO cost_settings (tenant_id, matching_provider_id) VALUES (1, 'claude-haiku-4-5');

CREATE TABLE IF NOT EXISTS vendors (
  id INT NOT NULL AUTO_INCREMENT, tenant_id INT NOT NULL,
  name VARCHAR(255) NOT NULL, tax_id VARCHAR(64), sap_code VARCHAR(64),
  category VARCHAR(64), embedding LONGTEXT,
  active TINYINT NOT NULL DEFAULT 1,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id), KEY vendors_tenant_idx (tenant_id), KEY vendors_taxid_idx (tax_id)
);

CREATE TABLE IF NOT EXISTS purchase_orders (
  id INT NOT NULL AUTO_INCREMENT, tenant_id INT NOT NULL,
  po_no VARCHAR(64) NOT NULL, vendor_id INT,
  vendor_name_snapshot VARCHAR(255),
  total_amount DECIMAL(15,2), currency VARCHAR(8) DEFAULT 'THB',
  status VARCHAR(16) NOT NULL DEFAULT 'open',
  description TEXT, description_embedding LONGTEXT,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id), UNIQUE KEY po_tenant_no_uq (tenant_id, po_no), KEY po_vendor_idx (vendor_id)
);

CREATE TABLE IF NOT EXISTS goods_receipts (
  id INT NOT NULL AUTO_INCREMENT, tenant_id INT NOT NULL,
  gr_no VARCHAR(64) NOT NULL, po_id INT,
  received_at DATE, total_received DECIMAL(15,2),
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id), UNIQUE KEY gr_tenant_no_uq (tenant_id, gr_no), KEY gr_po_idx (po_id)
);

CREATE TABLE IF NOT EXISTS posting_logs (
  id INT NOT NULL AUTO_INCREMENT, tenant_id INT NOT NULL, batch_id INT NOT NULL,
  posted_by_user_id INT NOT NULL, target VARCHAR(32) NOT NULL,
  mode VARCHAR(16) NOT NULL, status VARCHAR(16) NOT NULL,
  total_documents INT NOT NULL DEFAULT 0,
  total_amount DECIMAL(15,2), response_json LONGTEXT,
  posted_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id), KEY posting_logs_batch_idx (batch_id)
);

-- Matching columns on invoices (idempotent — ignored if already added)
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS doc_embedding LONGTEXT;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS vendor_embedding LONGTEXT;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS matched_vendor_id INT;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS vendor_match_score DECIMAL(5,4);
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS matched_po_id INT;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS po_match_score DECIMAL(5,4);
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS suggested_gl_code VARCHAR(64);
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS suggested_cost_center VARCHAR(64);
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS match_decision VARCHAR(16);
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS match_reasoning TEXT;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS match_at TIMESTAMP NULL;
SQL

echo "==> done"
echo "    docker compose ps"
sudo docker compose -f docker-compose.prod.yml ps
echo
echo "==> health check"
sleep 5
curl -fsS http://localhost:3737/health || true
echo
