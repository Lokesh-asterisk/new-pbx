-- White-labeling: per-tenant branding columns.
-- All nullable; NULL/empty = use app defaults ("PBX Call Centre", emoji logo, blue accent).

-- On first run you may see warning 1305 (procedure does not exist); safe to ignore.
DELIMITER //
DROP PROCEDURE IF EXISTS migrate_tenant_branding_024//
CREATE PROCEDURE migrate_tenant_branding_024()
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'tenants' AND column_name = 'product_name') THEN
    ALTER TABLE tenants ADD COLUMN product_name VARCHAR(128) DEFAULT NULL COMMENT 'White-label product name shown in header/login';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'tenants' AND column_name = 'logo_url') THEN
    ALTER TABLE tenants ADD COLUMN logo_url VARCHAR(512) DEFAULT NULL COMMENT 'URL or path to logo image';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'tenants' AND column_name = 'tagline') THEN
    ALTER TABLE tenants ADD COLUMN tagline VARCHAR(255) DEFAULT NULL COMMENT 'Subtitle / tagline on login page';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'tenants' AND column_name = 'primary_color') THEN
    ALTER TABLE tenants ADD COLUMN primary_color VARCHAR(32) DEFAULT NULL COMMENT 'Hex accent color e.g. #2563eb';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'tenants' AND column_name = 'favicon_url') THEN
    ALTER TABLE tenants ADD COLUMN favicon_url VARCHAR(512) DEFAULT NULL COMMENT 'URL or path to favicon';
  END IF;
END//
DELIMITER ;
CALL migrate_tenant_branding_024();
DROP PROCEDURE IF EXISTS migrate_tenant_branding_024;
