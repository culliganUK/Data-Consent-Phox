import { execSync } from "node:child_process";
import { mkdirSync } from "node:fs";

const key = process.env.MAXMIND_LICENSE_KEY;
if (!key) {
  console.warn("MAXMIND_LICENSE_KEY not set; skipping GeoLite2 download");
  process.exit(0);
}

mkdirSync("geoipdb", { recursive: true });

// Download & unpack GeoLite2 Country
execSync(
  `curl -L "https://download.maxmind.com/app/geoip_download?edition_id=GeoLite2-Country&license_key=${key}&suffix=tar.gz" \
  | tar -xz --strip-components=1 -C geoipdb`,
  { stdio: "inherit" }
);
