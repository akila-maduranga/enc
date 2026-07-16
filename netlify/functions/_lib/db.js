const { neon } = require("@neondatabase/serverless");

// One HTTP-based query function per invocation -- this is the serverless-friendly
// Neon driver (no persistent connection to manage/leak between cold starts).
function sql() {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is not set");
  }
  return neon(process.env.DATABASE_URL);
}

module.exports = { sql };
