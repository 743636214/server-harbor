import mysql from 'mysql2/promise';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
export async function createDatabase(env = process.env) {
  const local = ['127.0.0.1', 'localhost', '::1'].includes(env.MYSQL_HOST || '127.0.0.1');
  if (!env.MYSQL_SOCKET_PATH && !local && env.MYSQL_TLS !== 'true')
    throw new Error('远程 MySQL 必须启用 MYSQL_TLS=true 并校验服务器证书，或改用共享 Unix socket');
  const db = mysql.createPool({
    ...(env.MYSQL_SOCKET_PATH ? { socketPath: env.MYSQL_SOCKET_PATH } : {}),
    host: env.MYSQL_HOST || '127.0.0.1',
    port: Number(env.MYSQL_PORT || 3306),
    user: env.MYSQL_USER,
    password: env.MYSQL_PASSWORD,
    database: env.MYSQL_DATABASE || 'server_harbor',
    connectionLimit: 5,
    charset: 'utf8mb4',
    timezone: 'Z',
    ...(env.MYSQL_TLS === 'true'
      ? {
          ssl: {
            rejectUnauthorized: true,
            verifyIdentity: true,
            ...(env.MYSQL_SSL_CA_FILE ? { ca: await readFile(env.MYSQL_SSL_CA_FILE) } : {}),
          },
        }
      : {}),
  });
  // DATETIME has no zone; align each MySQL session with the driver's UTC conversion.
  db.on('connection', (connection) => {
    connection.query("SET time_zone = '+00:00'");
  });
  await db.query(
    `CREATE TABLE IF NOT EXISTS settings (name VARCHAR(64) PRIMARY KEY, value TEXT NOT NULL)`,
  );
  await db.query(`CREATE TABLE IF NOT EXISTS servers (
    id CHAR(36) PRIMARY KEY, name VARCHAR(100) NOT NULL, host VARCHAR(253) NOT NULL,
    port INT NOT NULL DEFAULT 22, username VARCHAR(64) NOT NULL, auth_type VARCHAR(16) NOT NULL,
    environment VARCHAR(16) NOT NULL DEFAULT 'production', group_name VARCHAR(64) NOT NULL DEFAULT '',
    tags JSON NOT NULL, notes TEXT NOT NULL, favorite BOOLEAN NOT NULL DEFAULT FALSE,
    credentials MEDIUMTEXT NOT NULL, fingerprint VARCHAR(100) NULL,
    last_connected_at DATETIME NULL, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  )`);
  await db.query(`CREATE TABLE IF NOT EXISTS connections (
    id CHAR(36) PRIMARY KEY, server_id CHAR(36), server_name VARCHAR(100) NOT NULL,
    status VARCHAR(24) NOT NULL, message VARCHAR(255) NOT NULL DEFAULT '',
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX (created_at), FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE SET NULL
  )`);
  await db.query(`CREATE TABLE IF NOT EXISTS users (
    id CHAR(36) PRIMARY KEY, username VARCHAR(64) NOT NULL UNIQUE, display_name VARCHAR(100) NOT NULL,
    password_hash TEXT NOT NULL, role VARCHAR(16) NOT NULL DEFAULT 'member', permissions JSON NOT NULL,
    active BOOLEAN NOT NULL DEFAULT TRUE, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  )`);
  await db.query(`CREATE TABLE IF NOT EXISTS sessions (
    token_hash CHAR(64) PRIMARY KEY, user_id CHAR(36) NOT NULL, expires_at DATETIME NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, INDEX (expires_at),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  )`);
  await db.query(`CREATE TABLE IF NOT EXISTS login_attempts (
    account_hash CHAR(64) PRIMARY KEY,
    failed_count TINYINT UNSIGNED NOT NULL DEFAULT 0,
    attempt_day DATE NULL, locked_until DATETIME(3) NULL,
    updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    INDEX (updated_at)
  )`);
  await db.query(`CREATE TABLE IF NOT EXISTS user_favorites (
    user_id CHAR(36) NOT NULL, server_id CHAR(36) NOT NULL, PRIMARY KEY(user_id,server_id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE
  )`);
  await db.query(`CREATE TABLE IF NOT EXISTS connection_actors (
    connection_id CHAR(36) PRIMARY KEY, user_id CHAR(36) NOT NULL, username VARCHAR(64) NOT NULL,
    ip VARCHAR(64) NOT NULL DEFAULT '',
    FOREIGN KEY (connection_id) REFERENCES connections(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id)
  )`);
  await db.query(`CREATE TABLE IF NOT EXISTS audit_events (
    id CHAR(36) PRIMARY KEY, actor_id CHAR(36) NULL, actor_username VARCHAR(64) NOT NULL,
    server_id CHAR(36) NULL, server_name VARCHAR(100) NOT NULL DEFAULT '', action VARCHAR(80) NOT NULL,
    outcome VARCHAR(16) NOT NULL, ip VARCHAR(64) NOT NULL DEFAULT '', details JSON NOT NULL,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    INDEX (created_at,id), INDEX (actor_id,created_at), INDEX (server_id,created_at)
  )`);
  await db.query(`CREATE TABLE IF NOT EXISTS recordings (
    connection_id CHAR(36) PRIMARY KEY, user_id CHAR(36) NOT NULL, username VARCHAR(64) NOT NULL,
    server_name VARCHAR(100) NOT NULL, state VARCHAR(24) NOT NULL DEFAULT 'recording',
    byte_count BIGINT NOT NULL DEFAULT 0, chunk_count BIGINT NOT NULL DEFAULT 0, sha256 CHAR(64) NULL,
    started_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), ended_at DATETIME(3) NULL
  )`);
  await db.query(`CREATE TABLE IF NOT EXISTS cloud_credentials (
    id CHAR(36) PRIMARY KEY, name VARCHAR(100) NOT NULL, provider VARCHAR(16) NOT NULL,
    default_region VARCHAR(64) NOT NULL DEFAULT '', project_id VARCHAR(128) NOT NULL DEFAULT '',
    credentials MEDIUMTEXT NOT NULL, active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  )`);
  await db.query(`CREATE TABLE IF NOT EXISTS server_cloud_bindings (
    server_id CHAR(36) PRIMARY KEY, credential_id CHAR(36) NOT NULL, region VARCHAR(64) NOT NULL,
    security_group_id VARCHAR(128) NOT NULL, project_id VARCHAR(128) NOT NULL DEFAULT '',
    FOREIGN KEY(server_id) REFERENCES servers(id) ON DELETE CASCADE,
    FOREIGN KEY(credential_id) REFERENCES cloud_credentials(id)
  )`);
  // Preserve the old administrator's password and server credentials during the v1 upgrade.
  const [[count]] = await db.query('SELECT COUNT(*) AS total FROM users');
  const [[legacy]] = await db.query("SELECT value FROM settings WHERE name='admin_password'");
  if (!count.total && legacy) {
    const id = randomUUID();
    await db.execute(
      "INSERT INTO users(id,username,display_name,password_hash,role,permissions) VALUES (?,'admin','管理员',?,'admin',JSON_OBJECT())",
      [id, legacy.value],
    );
    await db.execute(
      'INSERT IGNORE INTO user_favorites(user_id,server_id) SELECT ?,id FROM servers WHERE favorite=TRUE',
      [id],
    );
  }
  await db.execute(
    "DELETE FROM settings WHERE name='admin_password' AND EXISTS (SELECT 1 FROM users)",
  );
  await db.execute(
    "UPDATE recordings SET state='interrupted',ended_at=UTC_TIMESTAMP(3) WHERE state='recording'",
  );
  await db.query(`INSERT INTO audit_events(id,actor_id,actor_username,server_id,server_name,action,outcome,ip,details)
    SELECT UUID(),a.user_id,COALESCE(a.username,'legacy'),c.server_id,c.server_name,'ssh.interrupted','failed',COALESCE(a.ip,''),JSON_OBJECT('connectionId',c.id,'reason','service_restarted')
    FROM connections c LEFT JOIN connection_actors a ON a.connection_id=c.id WHERE c.status IN ('launching','connected')`);
  await db.execute(
    "UPDATE connections SET status='closed',message='服务重启，会话已中断' WHERE status IN ('launching','connected')",
  );
  return db;
}
export const publicColumns =
  'id, name, host, port, username, auth_type, environment, group_name, tags, notes, favorite, fingerprint, last_connected_at, created_at, updated_at';
export function publicServer(row) {
  return {
    ...row,
    favorite: Boolean(row.favorite),
    tags: typeof row.tags === 'string' ? JSON.parse(row.tags) : row.tags,
  };
}
