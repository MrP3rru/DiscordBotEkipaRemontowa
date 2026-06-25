require('dotenv').config();
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const { Pool } = require('pg');
const path = require('path');

let dbSQLite = null;
let pgPool = null;
let isPostgres = false;

/**
 * Inicjalizuje połączenie z bazą danych (PostgreSQL lub SQLite).
 */
async function initDatabase() {
  const connectionString = process.env.DATABASE_URL;

  if (connectionString && connectionString !== 'twój_connection_string_supabase_tutaj') {
    console.log('Wykryto DATABASE_URL. Próba połączenia z PostgreSQL (Supabase)...');
    try {
      pgPool = new Pool({
        connectionString: connectionString,
        ssl: {
          rejectUnauthorized: false
        },
        connectionTimeoutMillis: 5000 // Limit czasu na połączenie (5 sekund)
      });

      // Test połączenia
      const client = await pgPool.connect();
      try {
        // Tworzenie tabel w PostgreSQL
        await client.query(`
          CREATE TABLE IF NOT EXISTS active_sessions (
            user_id VARCHAR(30) PRIMARY KEY,
            guild_id VARCHAR(30) NOT NULL,
            join_time BIGINT NOT NULL
          )
        `);

        await client.query(`
          CREATE TABLE IF NOT EXISTS user_times (
            user_id VARCHAR(30),
            guild_id VARCHAR(30),
            total_time BIGINT DEFAULT 0,
            PRIMARY KEY (user_id, guild_id)
          )
        `);

        await client.query(`
          CREATE TABLE IF NOT EXISTS system_stats (
            stat_name VARCHAR(50) PRIMARY KEY,
            stat_value BIGINT DEFAULT 0
          )
        `);
        isPostgres = true;
        console.log('✅ Pomyślnie połączono z bazą PostgreSQL (Supabase) i zaktualizowano tabele.');
        return;
      } finally {
        client.release();
      }
    } catch (error) {
      console.error('❌ Błąd połączenia z PostgreSQL (Supabase):', error.message);
      console.log('⚠️ Następuje automatyczny powrót do lokalnej bazy danych SQLite, aby bot mógł działać...');
      isPostgres = false;
      pgPool = null;
    }
  }

  // Fallback do SQLite
  console.log('Inicjalizacja lokalnej bazy danych SQLite...');
  const dbPath = path.join(__dirname, 'database.sqlite');
  try {
    dbSQLite = await open({
      filename: dbPath,
      driver: sqlite3.Database
    });

    await dbSQLite.exec(`
      CREATE TABLE IF NOT EXISTS active_sessions (
        user_id TEXT PRIMARY KEY,
        guild_id TEXT NOT NULL,
        join_time INTEGER NOT NULL
      )
    `);

    await dbSQLite.exec(`
      CREATE TABLE IF NOT EXISTS user_times (
        user_id TEXT,
        guild_id TEXT,
        total_time INTEGER DEFAULT 0,
        PRIMARY KEY (user_id, guild_id)
      )
    `);

    await dbSQLite.exec(`
      CREATE TABLE IF NOT EXISTS system_stats (
        stat_name TEXT PRIMARY KEY,
        stat_value INTEGER DEFAULT 0
      )
    `);
    console.log('✅ Połączono z lokalną bazą danych SQLite.');
  } catch (error) {
    console.error('❌ Krytyczny błąd podczas inicjalizacji SQLite:', error);
    throw error;
  }
}

/**
 * Rozpoczyna sesję głosową (zapisuje czas wejścia).
 */
async function startVoiceSession(userId, guildId) {
  const now = Date.now();
  try {
    if (isPostgres && pgPool) {
      await pgPool.query(
        `INSERT INTO active_sessions (user_id, guild_id, join_time) 
         VALUES ($1, $2, $3) 
         ON CONFLICT (user_id) 
         DO UPDATE SET join_time = EXCLUDED.join_time`,
        [userId, guildId, now]
      );
    } else if (dbSQLite) {
      await dbSQLite.run(
        'INSERT OR REPLACE INTO active_sessions (user_id, guild_id, join_time) VALUES (?, ?, ?)',
        [userId, guildId, now]
      );
    }
  } catch (error) {
    console.error(`Błąd podczas rozpoczynania sesji dla ${userId}:`, error);
  }
}

/**
 * Kończy sesję głosową, oblicza spędzony czas i zapisuje go do bazy danych.
 */
async function endVoiceSession(userId, guildId) {
  try {
    let session = null;

    if (isPostgres && pgPool) {
      const res = await pgPool.query(
        'SELECT join_time FROM active_sessions WHERE user_id = $1 AND guild_id = $2',
        [userId, guildId]
      );
      if (res.rows.length > 0) {
        session = { join_time: Number(res.rows[0].join_time) };
      }
    } else if (dbSQLite) {
      session = await dbSQLite.get(
        'SELECT join_time FROM active_sessions WHERE user_id = ? AND guild_id = ?',
        [userId, guildId]
      );
    }

    if (!session) {
      return; // Brak aktywnej sesji
    }

    const duration = Date.now() - session.join_time;

    // Usuń aktywną sesję
    if (isPostgres && pgPool) {
      await pgPool.query(
        'DELETE FROM active_sessions WHERE user_id = $1 AND guild_id = $2',
        [userId, guildId]
      );
      // Zaktualizuj czas w Postgresie
      await pgPool.query(
        `INSERT INTO user_times (user_id, guild_id, total_time)
         VALUES ($1, $2, $3)
         ON CONFLICT(user_id, guild_id) DO UPDATE SET
         total_time = user_times.total_time + EXCLUDED.total_time`,
        [userId, guildId, duration]
      );
    } else if (dbSQLite) {
      await dbSQLite.run(
        'DELETE FROM active_sessions WHERE user_id = ? AND guild_id = ?',
        [userId, guildId]
      );
      // Zaktualizuj czas w SQLite
      await dbSQLite.run(
        `INSERT INTO user_times (user_id, guild_id, total_time)
         VALUES (?, ?, ?)
         ON CONFLICT(user_id, guild_id) DO UPDATE SET
         total_time = total_time + ?`,
        [userId, guildId, duration, duration]
      );
    }

  } catch (error) {
    console.error(`Błąd podczas kończenia sesji dla ${userId}:`, error);
  }
}

/**
 * Pobiera łączny czas spędzony przez użytkownika w milisekundach.
 */
async function getUserTime(userId, guildId) {
  try {
    let totalTime = 0;
    let activeJoinTime = null;

    if (isPostgres && pgPool) {
      // Pobierz zapisany czas
      const resTime = await pgPool.query(
        'SELECT total_time FROM user_times WHERE user_id = $1 AND guild_id = $2',
        [userId, guildId]
      );
      if (resTime.rows.length > 0) {
        totalTime = Number(resTime.rows[0].total_time);
      }

      // Sprawdź, czy użytkownik jest obecnie na kanale
      const resActive = await pgPool.query(
        'SELECT join_time FROM active_sessions WHERE user_id = $1 AND guild_id = $2',
        [userId, guildId]
      );
      if (resActive.rows.length > 0) {
        activeJoinTime = Number(resActive.rows[0].join_time);
      }
    } else if (dbSQLite) {
      // Pobierz zapisany czas w SQLite
      const rowTime = await dbSQLite.get(
        'SELECT total_time FROM user_times WHERE user_id = ? AND guild_id = ?',
        [userId, guildId]
      );
      if (rowTime) {
        totalTime = rowTime.total_time;
      }

      // Sprawdź aktywną sesję w SQLite
      const rowActive = await dbSQLite.get(
        'SELECT join_time FROM active_sessions WHERE user_id = ? AND guild_id = ?',
        [userId, guildId]
      );
      if (rowActive) {
        activeJoinTime = rowActive.join_time;
      }
    }

    // Dodaj czas na żywo, jeśli użytkownik nadal rozmawia
    if (activeJoinTime) {
      totalTime += (Date.now() - activeJoinTime);
    }

    return totalTime;
  } catch (error) {
    console.error(`Błąd pobierania czasu dla ${userId}:`, error);
    return 0;
  }
}

/**
 * Pobiera listę liderów (najlepszych użytkowników) według spędzonego czasu.
 */
async function getLeaderboard(guildId, limit = 10) {
  try {
    if (isPostgres && pgPool) {
      const res = await pgPool.query(
        'SELECT user_id, total_time FROM user_times WHERE guild_id = $1 ORDER BY total_time DESC LIMIT $2',
        [guildId, limit]
      );
      return res.rows.map(row => ({
        user_id: row.user_id,
        total_time: Number(row.total_time)
      }));
    } else if (dbSQLite) {
      const rows = await dbSQLite.all(
        'SELECT user_id, total_time FROM user_times WHERE guild_id = ? ORDER BY total_time DESC LIMIT ?',
        [guildId, limit]
      );
      return rows;
    }
    return [];
  } catch (error) {
    console.error('Błąd pobierania rankingu:', error);
    return [];
  }
}

/**
 * Zwiększa licznik usuniętych wiadomości w bazie o podaną wartość.
 */
async function incrementDeletedMessages(count) {
  try {
    if (isPostgres && pgPool) {
      await pgPool.query(
        `INSERT INTO system_stats (stat_name, stat_value)
         VALUES ('deleted_messages', $1)
         ON CONFLICT (stat_name)
         DO UPDATE SET stat_value = system_stats.stat_value + EXCLUDED.stat_value`,
        [count]
      );
    } else if (dbSQLite) {
      await dbSQLite.run(
        `INSERT INTO system_stats (stat_name, stat_value)
         VALUES ('deleted_messages', ?)
         ON CONFLICT (stat_name)
         DO UPDATE SET stat_value = stat_value + ?`,
        [count, count]
      );
    }
  } catch (error) {
    console.error('Błąd podczas inkrementacji usuniętych wiadomości:', error);
  }
}

/**
 * Pobiera łączną liczbę usuniętych wiadomości.
 */
async function getDeletedMessagesCount() {
  try {
    if (isPostgres && pgPool) {
      const res = await pgPool.query(
        "SELECT stat_value FROM system_stats WHERE stat_name = 'deleted_messages'"
      );
      return res.rows.length > 0 ? Number(res.rows[0].stat_value) : 0;
    } else if (dbSQLite) {
      const row = await dbSQLite.get(
        "SELECT stat_value FROM system_stats WHERE stat_name = 'deleted_messages'"
      );
      return row ? row.stat_value : 0;
    }
    return 0;
  } catch (error) {
    console.error('Błąd pobierania licznika usuniętych wiadomości:', error);
    return 0;
  }
}

module.exports = {
  initDatabase,
  startVoiceSession,
  endVoiceSession,
  getUserTime,
  getLeaderboard,
  incrementDeletedMessages,
  getDeletedMessagesCount
};
