declare namespace Cloudflare {
  interface Env {
    DB?: D1Database;
    BUCKET?: R2Bucket;
    SAATHI_SECRET?: string;
    OWNER_EMAIL?: string;
  }
}
