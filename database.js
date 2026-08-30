require('dotenv').config();
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const { Pool } = require('pg');
const path = require('path');

let dbSQLite = null;
let pgPool = null;
let isPostgres = false;

/**
 * Zwraca datę w formacie YYYY-MM-DD dla strefy czasowej Europe/Warsaw
 */
function getWarsawDateString(timestamp = Date.now()) {
  const d = new Date(timestamp);
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Warsaw',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });
  return formatter.format(d); // np. "2026-08-20"
}

/**
 * Zwraca zakres dat (start i end w formacie YYYY-MM-DD) dla bieżącego tygodnia (od poniedziałku do niedzieli)
 */
function getCurrentWeekRange() {
  const now = new Date();
  const warsawStr = getWarsawDateString(now.getTime());
  const [year, month, day] = warsawStr.split('-').map(Number);
  
  const currentWarsawDate = new Date(Date.UTC(year, month - 1, day));
  const dayOfWeek = currentWarsawDate.getUTCDay();
  const diffToMonday = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
  
  const monday = new Date(currentWarsawDate);
  monday.setUTCDate(currentWarsawDate.getUTCDate() + diffToMonday);
  
  const sunday = new Date(monday);
  sunday.setUTCDate(monday.getUTCDate() + 6);
  
  const formatDate = (d) => {
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    const dayNum = String(d.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${dayNum}`;
  };
  
  return {
    startDate: formatDate(monday),
    endDate: formatDate(sunday)
  };
}

/**
 * Zwraca zakres dat dla bieżącego miesiąca
 */
function getCurrentMonthRange() {
  const warsawStr = getWarsawDateString();
  const [year, month] = warsawStr.split('-');
  return {
    prefix: `${year}-${month}`,
    startDate: `${year}-${month}-01`,
    endDate: `${year}-${month}-31`
  };
}

/**
 * Dzieli sesję głosową na poszczególne dni, jeśli sesja przekroczyła północ.
 */
function splitSessionByDays(startMs, endMs) {
  if (endMs <= startMs) return [];

  const chunks = [];
  let currentStart = startMs;

  while (currentStart < endMs) {
    const dateStr = getWarsawDateString(currentStart);
    const [y, m, d] = dateStr.split('-').map(Number);
    const nextDayDate = new Date(Date.UTC(y, m - 1, d + 1, 0, 0, 0));
    
    let nextMidnightMs = nextDayDate.getTime() - (2 * 60 * 60 * 1000);
    if (getWarsawDateString(nextMidnightMs) !== dateStr) {
      nextMidnightMs = nextDayDate.getTime() - (1 * 60 * 60 * 1000);
    }
    
    const chunkEnd = (nextMidnightMs > currentStart && nextMidnightMs < endMs) ? nextMidnightMs : endMs;
    const duration = chunkEnd - currentStart;

    if (duration > 0) {
      chunks.push({
        date: dateStr,
        duration: duration
      });
    }

    currentStart = chunkEnd;
  }

  return chunks;
}

/**
 * Bezpieczne wykonywanie zapytań do PostgreSQL z automatycznym ponawianiem w razie zerwania połączenia / idle timeout (57P01).
 */
async function queryPg(text, params = []) {
  if (!pgPool) throw new Error('Brak aktywnego połączenia z PostgreSQL');
  try {
    return await pgPool.query(text, params);
  } catch (error) {
    const isTransientError = error.code === '57P01' || 
                             error.code === '57P03' || 
                             error.code === '08006' ||
                             (error.message && (
                               error.message.includes('terminating connection') ||
                               error.message.includes('Connection terminated') ||
                               error.message.includes('socket hang up') ||
                               error.message.includes('ECONNRESET')
                             ));

    if (isTransientError) {
      console.warn('⚠️ [PostgreSQL Pool] Nastąpiło zerwanie połączenia przez serwer. Ponawiam zapytanie...');
      await new Promise(res => setTimeout(res, 200));
      return await pgPool.query(text, params);
    }
    throw error;
  }
}

/**
 * Inicjalizuje połączenie z bazą danych (PostgreSQL lub SQLite).
 */
async function initDatabase() {
  const connectionString = process.env.DATABASE_URL;

  // Zawsze inicjalizujemy bazę SQLite jako bazę zapasową / lokalną
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
        join_time INTEGER NOT NULL,
        channel_id TEXT
      )
    `);

    const tableInfo = await dbSQLite.all(`PRAGMA table_info(active_sessions)`);
    const hasChannelCol = tableInfo.some(col => col.name === 'channel_id');
    if (!hasChannelCol) {
      try {
        await dbSQLite.exec(`ALTER TABLE active_sessions ADD COLUMN channel_id TEXT`);
      } catch (e) {
        // Ignoruj
      }
    }

    await dbSQLite.exec(`
      CREATE TABLE IF NOT EXISTS user_times (
        user_id TEXT,
        guild_id TEXT,
        total_time INTEGER DEFAULT 0,
        PRIMARY KEY (user_id, guild_id)
      )
    `);

    await dbSQLite.exec(`
      CREATE TABLE IF NOT EXISTS user_daily_times (
        user_id TEXT NOT NULL,
        guild_id TEXT NOT NULL,
        date TEXT NOT NULL,
        time_spent INTEGER DEFAULT 0,
        PRIMARY KEY (user_id, guild_id, date)
      )
    `);

    await dbSQLite.exec(`
      CREATE TABLE IF NOT EXISTS system_stats (
        stat_name TEXT PRIMARY KEY,
        stat_value INTEGER DEFAULT 0
      )
    `);
  } catch (error) {
    console.error('❌ Błąd inicjalizacji zapasowej bazy SQLite:', error);
  }

  // Próba połączenia z PostgreSQL (Supabase)
  if (connectionString && connectionString !== 'twój_connection_string_supabase_tutaj') {
    console.log('Wykryto DATABASE_URL. Próba połączenia z PostgreSQL (Supabase)...');
    try {
      pgPool = new Pool({
        connectionString: connectionString,
        ssl: {
          rejectUnauthorized: false
        },
        max: 10,
        idleTimeoutMillis: 15000,
        connectionTimeoutMillis: 5000,
        allowExitOnIdle: false
      });

      pgPool.on('error', (err) => {
        console.warn('⚠️ [PostgreSQL Pool] Ostrzeżenie bezczynnego klienta (zostanie zrestartowany):', err.message);
      });

      await queryPg(`
        CREATE TABLE IF NOT EXISTS active_sessions (
          user_id VARCHAR(30) PRIMARY KEY,
          guild_id VARCHAR(30) NOT NULL,
          join_time BIGINT NOT NULL,
          channel_id VARCHAR(30)
        )
      `);

      try {
        await queryPg(`ALTER TABLE active_sessions ADD COLUMN IF NOT EXISTS channel_id VARCHAR(30)`);
      } catch (e) {
        // Ignoruj jeśli kolumna już istnieje
      }

      await queryPg(`
        CREATE TABLE IF NOT EXISTS user_times (
          user_id VARCHAR(30),
          guild_id VARCHAR(30),
          total_time BIGINT DEFAULT 0,
          PRIMARY KEY (user_id, guild_id)
        )
      `);

      await queryPg(`
        CREATE TABLE IF NOT EXISTS user_daily_times (
          user_id VARCHAR(30) NOT NULL,
          guild_id VARCHAR(30) NOT NULL,
          date VARCHAR(10) NOT NULL,
          time_spent BIGINT DEFAULT 0,
          PRIMARY KEY (user_id, guild_id, date)
        )
      `);

      await queryPg(`
        CREATE TABLE IF NOT EXISTS system_stats (
          stat_name VARCHAR(50) PRIMARY KEY,
          stat_value BIGINT DEFAULT 0
        )
      `);

      // Zabezpieczenie Supabase (Row Level Security - RLS)
      // Blokuje nieautoryzowany dostęp przez publiczne API REST Supabase,
      // jednocześnie pozwalając botowi (jako połączenie bezpośrednie Postgres) działać bez przeszkód.
      await queryPg(`ALTER TABLE active_sessions ENABLE ROW LEVEL SECURITY`);
      await queryPg(`ALTER TABLE user_times ENABLE ROW LEVEL SECURITY`);
      await queryPg(`ALTER TABLE user_daily_times ENABLE ROW LEVEL SECURITY`);
      await queryPg(`ALTER TABLE system_stats ENABLE ROW LEVEL SECURITY`);

      isPostgres = true;
      console.log('✅ Pomyślnie połączono z bazą PostgreSQL (Supabase), zaktualizowano tabele i włączono RLS.');
      return;
    } catch (error) {
      console.error('❌ Błąd połączenia z PostgreSQL (Supabase):', error.message);
      console.log('⚠️ Następuje automatyczny powrót do lokalnej bazy danych SQLite, aby bot mógł działać...');
      isPostgres = false;
    }
  }

  console.log('✅ Działanie w trybie lokalnej bazy danych SQLite.');
}

/**
 * Rozpoczyna sesję głosową (zapisuje czas wejścia oraz ID kanału).
 */
async function startVoiceSession(userId, guildId, channelId = null) {
  const now = Date.now();
  try {
    if (isPostgres && pgPool) {
      await queryPg(
        `INSERT INTO active_sessions (user_id, guild_id, join_time, channel_id) 
         VALUES ($1, $2, $3, $4) 
         ON CONFLICT (user_id) 
         DO UPDATE SET join_time = EXCLUDED.join_time, guild_id = EXCLUDED.guild_id, channel_id = EXCLUDED.channel_id`,
        [userId, guildId, now, channelId]
      );
    } else if (dbSQLite) {
      await dbSQLite.run(
        'INSERT OR REPLACE INTO active_sessions (user_id, guild_id, join_time, channel_id) VALUES (?, ?, ?, ?)',
        [userId, guildId, now, channelId]
      );
    }
  } catch (error) {
    console.error(`Błąd podczas rozpoczynania sesji dla ${userId}:`, error);
  }
}

/**
 * Kończy sesję głosową, oblicza spędzony czas i zapisuje go do bazy danych (całkowity oraz podział na dni).
 */
async function endVoiceSession(userId, guildId) {
  try {
    let session = null;

    if (isPostgres && pgPool) {
      const res = await queryPg(
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
      return;
    }

    const now = Date.now();
    const duration = now - session.join_time;

    if (isPostgres && pgPool) {
      await queryPg(
        'DELETE FROM active_sessions WHERE user_id = $1 AND guild_id = $2',
        [userId, guildId]
      );

      await queryPg(
        `INSERT INTO user_times (user_id, guild_id, total_time)
         VALUES ($1, $2, $3)
         ON CONFLICT(user_id, guild_id) DO UPDATE SET
         total_time = user_times.total_time + EXCLUDED.total_time`,
        [userId, guildId, duration]
      );

      const dayChunks = splitSessionByDays(session.join_time, now);
      for (const chunk of dayChunks) {
        await queryPg(
          `INSERT INTO user_daily_times (user_id, guild_id, date, time_spent)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT(user_id, guild_id, date) DO UPDATE SET
           time_spent = user_daily_times.time_spent + EXCLUDED.time_spent`,
          [userId, guildId, chunk.date, chunk.duration]
        );
      }
    } else if (dbSQLite) {
      await dbSQLite.run(
        'DELETE FROM active_sessions WHERE user_id = ? AND guild_id = ?',
        [userId, guildId]
      );

      await dbSQLite.run(
        `INSERT INTO user_times (user_id, guild_id, total_time)
         VALUES (?, ?, ?)
         ON CONFLICT(user_id, guild_id) DO UPDATE SET
         total_time = total_time + ?`,
        [userId, guildId, duration, duration]
      );

      const dayChunks = splitSessionByDays(session.join_time, now);
      for (const chunk of dayChunks) {
        await dbSQLite.run(
          `INSERT INTO user_daily_times (user_id, guild_id, date, time_spent)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(user_id, guild_id, date) DO UPDATE SET
           time_spent = time_spent + ?`,
          [userId, guildId, chunk.date, chunk.duration, chunk.duration]
        );
      }
    }

  } catch (error) {
    console.error(`Błąd podczas kończenia sesji dla ${userId}:`, error);
  }
}

/**
 * Zapisuje postęp trwających sesji w tle (checkpoint), zapobiegając utracie godzin przy restarcie i zapewniając idealne rozliczanie dni.
 */
async function checkpointActiveSessions() {
  try {
    const now = Date.now();
    let sessions = [];
    if (isPostgres && pgPool) {
      const res = await queryPg('SELECT user_id, guild_id, join_time, channel_id FROM active_sessions');
      sessions = res.rows;
    } else if (dbSQLite) {
      sessions = await dbSQLite.all('SELECT user_id, guild_id, join_time, channel_id FROM active_sessions');
    }

    for (const s of sessions) {
      const joinTime = Number(s.join_time);
      const duration = now - joinTime;
      // Wykonujemy checkpoint tylko jeśli sesja trwa co najmniej 1 minutę
      if (duration >= 60000) {
        const chunks = splitSessionByDays(joinTime, now);
        if (isPostgres && pgPool) {
          await queryPg(
            `INSERT INTO user_times (user_id, guild_id, total_time) VALUES ($1, $2, $3)
             ON CONFLICT(user_id, guild_id) DO UPDATE SET total_time = user_times.total_time + EXCLUDED.total_time`,
            [s.user_id, s.guild_id, duration]
          );
          for (const chunk of chunks) {
            await queryPg(
              `INSERT INTO user_daily_times (user_id, guild_id, date, time_spent) VALUES ($1, $2, $3, $4)
               ON CONFLICT(user_id, guild_id, date) DO UPDATE SET time_spent = user_daily_times.time_spent + EXCLUDED.time_spent`,
              [s.user_id, s.guild_id, chunk.date, chunk.duration]
            );
          }
          await queryPg(
            `UPDATE active_sessions SET join_time = $1 WHERE user_id = $2 AND guild_id = $3`,
            [now, s.user_id, s.guild_id]
          );
        } else if (dbSQLite) {
          await dbSQLite.run(
            `INSERT INTO user_times (user_id, guild_id, total_time) VALUES (?, ?, ?)
             ON CONFLICT(user_id, guild_id) DO UPDATE SET total_time = total_time + ?`,
            [s.user_id, s.guild_id, duration, duration]
          );
          for (const chunk of chunks) {
            await dbSQLite.run(
              `INSERT INTO user_daily_times (user_id, guild_id, date, time_spent) VALUES (?, ?, ?, ?)
               ON CONFLICT(user_id, guild_id, date) DO UPDATE SET time_spent = time_spent + ?`,
              [s.user_id, s.guild_id, chunk.date, chunk.duration, chunk.duration]
            );
          }
          await dbSQLite.run(
            `UPDATE active_sessions SET join_time = ? WHERE user_id = ? AND guild_id = ?`,
            [now, s.user_id, s.guild_id]
          );
        }
      }
    }
  } catch (err) {
    console.warn('Ostrzeżenie podczas checkpointActiveSessions:', err.message);
  }
}

/**
 * Pobiera aktywną sesję użytkownika na serwerze (jeśli obecnie przebywa na kanale)
 */
async function getActiveSession(userId, guildId) {
  try {
    if (isPostgres && pgPool) {
      const res = await queryPg(
        'SELECT join_time, channel_id FROM active_sessions WHERE user_id = $1 AND guild_id = $2',
        [userId, guildId]
      );
      if (res.rows.length > 0) {
        return {
          join_time: Number(res.rows[0].join_time),
          channel_id: res.rows[0].channel_id
        };
      }
    } else if (dbSQLite) {
      const row = await dbSQLite.get(
        'SELECT join_time, channel_id FROM active_sessions WHERE user_id = ? AND guild_id = ?',
        [userId, guildId]
      );
      if (row) {
        return {
          join_time: Number(row.join_time),
          channel_id: row.channel_id
        };
      }
    }
    return null;
  } catch (error) {
    console.error(`Błąd pobierania aktywnej sesji dla ${userId}:`, error);
    return null;
  }
}

/**
 * Oblicza ile z trwającej aktywnej sesji przypada na dziś, ten tydzień, ten miesiąc i łącznie.
 */
function getActiveSessionBreakdown(activeSession) {
  if (!activeSession) {
    return { today: 0, week: 0, month: 0, total: 0 };
  }

  const now = Date.now();
  const chunks = splitSessionByDays(activeSession.join_time, now);
  const todayStr = getWarsawDateString(now);
  const weekRange = getCurrentWeekRange();
  const monthRange = getCurrentMonthRange();

  let today = 0;
  let week = 0;
  let month = 0;
  let total = now - activeSession.join_time;

  for (const chunk of chunks) {
    if (chunk.date === todayStr) {
      today += chunk.duration;
    }
    if (chunk.date >= weekRange.startDate && chunk.date <= weekRange.endDate) {
      week += chunk.duration;
    }
    if (chunk.date >= monthRange.startDate && chunk.date <= monthRange.endDate) {
      month += chunk.duration;
    }
  }

  return { today, week, month, total };
}

/**
 * Pobiera łączny czas spędzony przez użytkownika w milisekundach.
 */
async function getUserTime(userId, guildId) {
  try {
    let totalTime = 0;

    if (isPostgres && pgPool) {
      const resTime = await queryPg(
        'SELECT total_time FROM user_times WHERE user_id = $1 AND guild_id = $2',
        [userId, guildId]
      );
      if (resTime.rows.length > 0) {
        totalTime = Number(resTime.rows[0].total_time);
      }
    } else if (dbSQLite) {
      const rowTime = await dbSQLite.get(
        'SELECT total_time FROM user_times WHERE user_id = ? AND guild_id = ?',
        [userId, guildId]
      );
      if (rowTime) {
        totalTime = Number(rowTime.total_time);
      }
    }

    const activeSession = await getActiveSession(userId, guildId);
    if (activeSession) {
      totalTime += (Date.now() - activeSession.join_time);
    }

    return totalTime;
  } catch (error) {
    console.error(`Błąd pobierania czasu dla ${userId}:`, error);
    return 0;
  }
}

/**
 * Pobiera czas użytkownika dla konkretnego okresu: 'today', 'week', 'month', 'all'
 */
async function getUserPeriodTime(userId, guildId, period = 'all') {
  try {
    const activeSession = await getActiveSession(userId, guildId);
    const activeBreakdown = getActiveSessionBreakdown(activeSession);

    if (period === 'all') {
      return await getUserTime(userId, guildId);
    }

    const todayStr = getWarsawDateString();
    const weekRange = getCurrentWeekRange();
    const monthRange = getCurrentMonthRange();

    let queryTime = 0;

    if (isPostgres && pgPool) {
      if (period === 'today') {
        const res = await queryPg(
          'SELECT SUM(time_spent) as period_time FROM user_daily_times WHERE user_id = $1 AND guild_id = $2 AND date = $3',
          [userId, guildId, todayStr]
        );
        queryTime = Number(res.rows[0]?.period_time || 0);
        return queryTime + activeBreakdown.today;
      } else if (period === 'week') {
        const res = await queryPg(
          'SELECT SUM(time_spent) as period_time FROM user_daily_times WHERE user_id = $1 AND guild_id = $2 AND date >= $3 AND date <= $4',
          [userId, guildId, weekRange.startDate, weekRange.endDate]
        );
        queryTime = Number(res.rows[0]?.period_time || 0);
        return queryTime + activeBreakdown.week;
      } else if (period === 'month') {
        const res = await queryPg(
          'SELECT SUM(time_spent) as period_time FROM user_daily_times WHERE user_id = $1 AND guild_id = $2 AND date >= $3 AND date <= $4',
          [userId, guildId, monthRange.startDate, monthRange.endDate]
        );
        queryTime = Number(res.rows[0]?.period_time || 0);
        return queryTime + activeBreakdown.month;
      }
    } else if (dbSQLite) {
      if (period === 'today') {
        const row = await dbSQLite.get(
          'SELECT SUM(time_spent) as period_time FROM user_daily_times WHERE user_id = ? AND guild_id = ? AND date = ?',
          [userId, guildId, todayStr]
        );
        queryTime = Number(row?.period_time || 0);
        return queryTime + activeBreakdown.today;
      } else if (period === 'week') {
        const row = await dbSQLite.get(
          'SELECT SUM(time_spent) as period_time FROM user_daily_times WHERE user_id = ? AND guild_id = ? AND date >= ? AND date <= ?',
          [userId, guildId, weekRange.startDate, weekRange.endDate]
        );
        queryTime = Number(row?.period_time || 0);
        return queryTime + activeBreakdown.week;
      } else if (period === 'month') {
        const row = await dbSQLite.get(
          'SELECT SUM(time_spent) as period_time FROM user_daily_times WHERE user_id = ? AND guild_id = ? AND date >= ? AND date <= ?',
          [userId, guildId, monthRange.startDate, monthRange.endDate]
        );
        queryTime = Number(row?.period_time || 0);
        return queryTime + activeBreakdown.month;
      }
    }

    return 0;
  } catch (error) {
    console.error(`Błąd pobierania czasu okresowego (${period}) dla ${userId}:`, error);
    return 0;
  }
}

/**
 * Pobiera pełne statystyki użytkownika (dzisiaj, tydzień, miesiąc, łącznie, aktywna sesja, pozycje w rankingach)
 */
async function getUserStats(userId, guildId) {
  try {
    const todayStr = getWarsawDateString();
    const weekRange = getCurrentWeekRange();
    const monthRange = getCurrentMonthRange();

    let savedToday = 0;
    let savedWeek = 0;
    let savedMonth = 0;
    let savedTotal = 0;

    if (isPostgres && pgPool) {
      const [resTotal, resToday, resWeek, resMonth] = await Promise.all([
        queryPg('SELECT total_time FROM user_times WHERE user_id = $1 AND guild_id = $2', [userId, guildId]),
        queryPg('SELECT SUM(time_spent) as t FROM user_daily_times WHERE user_id = $1 AND guild_id = $2 AND date = $3', [userId, guildId, todayStr]),
        queryPg('SELECT SUM(time_spent) as t FROM user_daily_times WHERE user_id = $1 AND guild_id = $2 AND date >= $3 AND date <= $4', [userId, guildId, weekRange.startDate, weekRange.endDate]),
        queryPg('SELECT SUM(time_spent) as t FROM user_daily_times WHERE user_id = $1 AND guild_id = $2 AND date >= $3 AND date <= $4', [userId, guildId, monthRange.startDate, monthRange.endDate]),
      ]);

      savedTotal = Number(resTotal.rows[0]?.total_time || 0);
      savedToday = Number(resToday.rows[0]?.t || 0);
      savedWeek = Number(resWeek.rows[0]?.t || 0);
      savedMonth = Number(resMonth.rows[0]?.t || 0);
    } else if (dbSQLite) {
      const [rowTotal, rowToday, rowWeek, rowMonth] = await Promise.all([
        dbSQLite.get('SELECT total_time FROM user_times WHERE user_id = ? AND guild_id = ?', [userId, guildId]),
        dbSQLite.get('SELECT SUM(time_spent) as t FROM user_daily_times WHERE user_id = ? AND guild_id = ? AND date = ?', [userId, guildId, todayStr]),
        dbSQLite.get('SELECT SUM(time_spent) as t FROM user_daily_times WHERE user_id = ? AND guild_id = ? AND date >= ? AND date <= ?', [userId, guildId, weekRange.startDate, weekRange.endDate]),
        dbSQLite.get('SELECT SUM(time_spent) as t FROM user_daily_times WHERE user_id = ? AND guild_id = ? AND date >= ? AND date <= ?', [userId, guildId, monthRange.startDate, monthRange.endDate]),
      ]);

      savedTotal = Number(rowTotal?.total_time || 0);
      savedToday = Number(rowToday?.t || 0);
      savedWeek = Number(rowWeek?.t || 0);
      savedMonth = Number(rowMonth?.t || 0);
    }

    const activeSession = await getActiveSession(userId, guildId);
    const activeBreakdown = getActiveSessionBreakdown(activeSession);

    const total = savedTotal + activeBreakdown.total;
    const today = savedToday + activeBreakdown.today;
    const week = savedWeek + activeBreakdown.week;
    const month = savedMonth + activeBreakdown.month;

    // Obliczamy pozycje w rankingu
    const [rankTotal, rankToday, rankWeek, rankMonth] = await Promise.all([
      getUserRank(userId, guildId, 'all'),
      getUserRank(userId, guildId, 'today'),
      getUserRank(userId, guildId, 'week'),
      getUserRank(userId, guildId, 'month')
    ]);

    return {
      today,
      week,
      month,
      total,
      activeSession,
      ranks: {
        total: rankTotal,
        today: rankToday,
        week: rankWeek,
        month: rankMonth
      }
    };
  } catch (error) {
    console.error(`Błąd pobierania statystyk dla ${userId}:`, error);
    return {
      today: 0,
      week: 0,
      month: 0,
      total: 0,
      activeSession: null,
      ranks: { total: null, today: null, week: null, month: null }
    };
  }
}

/**
 * Oblicza pozycję użytkownika w rankingu (1-indexed) dla danego okresu.
 */
async function getUserRank(userId, guildId, period = 'all') {
  try {
    const list = await getAllUsersSorted(guildId, period);
    const index = list.findIndex(item => item.user_id === userId);
    return index !== -1 ? index + 1 : null;
  } catch (error) {
    console.error('Błąd getUserRank:', error);
    return null;
  }
}

/**
 * Pomocnicza funkcja pobierająca zagregowaną i posortowaną listę użytkowników wraz z uwzględnieniem aktywnych sesji na żywo.
 */
async function getAllUsersSorted(guildId, period = 'all') {
  const todayStr = getWarsawDateString();
  const weekRange = getCurrentWeekRange();
  const monthRange = getCurrentMonthRange();

  let map = new Map();

  if (isPostgres && pgPool) {
    if (period === 'all') {
      const res = await queryPg('SELECT user_id, total_time as time FROM user_times WHERE guild_id = $1', [guildId]);
      for (const row of res.rows) {
        map.set(row.user_id, Number(row.time));
      }
    } else {
      let dateFilter = 'date = $2';
      let params = [guildId, todayStr];
      if (period === 'week') {
        dateFilter = 'date >= $2 AND date <= $3';
        params = [guildId, weekRange.startDate, weekRange.endDate];
      } else if (period === 'month') {
        dateFilter = 'date >= $2 AND date <= $3';
        params = [guildId, monthRange.startDate, monthRange.endDate];
      }
      const res = await queryPg(
        `SELECT user_id, SUM(time_spent) as time FROM user_daily_times WHERE guild_id = $1 AND ${dateFilter} GROUP BY user_id`,
        params
      );
      for (const row of res.rows) {
        map.set(row.user_id, Number(row.time));
      }
    }
  } else if (dbSQLite) {
    if (period === 'all') {
      const rows = await dbSQLite.all('SELECT user_id, total_time as time FROM user_times WHERE guild_id = ?', [guildId]);
      for (const row of rows) {
        map.set(row.user_id, Number(row.time));
      }
    } else {
      let dateFilter = 'date = ?';
      let params = [guildId, todayStr];
      if (period === 'week') {
        dateFilter = 'date >= ? AND date <= ?';
        params = [guildId, weekRange.startDate, weekRange.endDate];
      } else if (period === 'month') {
        dateFilter = 'date >= ? AND date <= ?';
        params = [guildId, monthRange.startDate, monthRange.endDate];
      }
      const rows = await dbSQLite.all(
        `SELECT user_id, SUM(time_spent) as time FROM user_daily_times WHERE guild_id = ? AND ${dateFilter} GROUP BY user_id`,
        params
      );
      for (const row of rows) {
        map.set(row.user_id, Number(row.time));
      }
    }
  }

  // Uwzględniamy aktywne sesje na żywo
  let activeSessions = [];
  try {
    if (isPostgres && pgPool) {
      const res = await queryPg('SELECT user_id, join_time FROM active_sessions WHERE guild_id = $1', [guildId]);
      activeSessions = res.rows;
    } else if (dbSQLite) {
      activeSessions = await dbSQLite.all('SELECT user_id, join_time FROM active_sessions WHERE guild_id = ?', [guildId]);
    }
  } catch (err) {
    console.error('Błąd pobierania aktywnych sesji dla rankingu:', err.message);
  }

  for (const s of activeSessions) {
    const breakdown = getActiveSessionBreakdown({ join_time: Number(s.join_time) });
    let additional = 0;
    if (period === 'all') additional = breakdown.total;
    else if (period === 'today') additional = breakdown.today;
    else if (period === 'week') additional = breakdown.week;
    else if (period === 'month') additional = breakdown.month;

    if (additional > 0) {
      const current = map.get(s.user_id) || 0;
      map.set(s.user_id, current + additional);
    }
  }

  const list = [];
  for (const [userId, time] of map.entries()) {
    if (time > 0) {
      list.push({ user_id: userId, total_time: time });
    }
  }

  list.sort((a, b) => b.total_time - a.total_time);
  return list;
}

/**
 * Pobiera ranking z paginacją oraz wsparciem dla okresów (all, today, week, month).
 */
async function getLeaderboard(guildId, limit = 10, offset = 0, period = 'all') {
  try {
    const list = await getAllUsersSorted(guildId, period);
    const paginated = list.slice(offset, offset + limit);
    return {
      entries: paginated,
      totalCount: list.length,
      page: Math.floor(offset / limit) + 1,
      totalPages: Math.max(1, Math.ceil(list.length / limit))
    };
  } catch (error) {
    console.error('Błąd pobierania rankingu:', error.message);
    return { entries: [], totalCount: 0, page: 1, totalPages: 1 };
  }
}

/**
 * Zwiększa licznik usuniętych wiadomości w bazie o podaną wartość.
 */
async function incrementDeletedMessages(count) {
  try {
    if (isPostgres && pgPool) {
      await queryPg(
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
    console.error('Błąd podczas inkrementacji usuniętych wiadomości:', error.message);
  }
}

/**
 * Pobiera łączną liczbę usuniętych wiadomości.
 */
async function getDeletedMessagesCount() {
  try {
    if (isPostgres && pgPool) {
      const res = await queryPg(
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
    console.error('Błąd pobierania licznika usuniętych wiadomości:', error.message);
    return 0;
  }
}

module.exports = {
  initDatabase,
  startVoiceSession,
  endVoiceSession,
  checkpointActiveSessions,
  getUserTime,
  getUserPeriodTime,
  getUserStats,
  getUserRank,
  getLeaderboard,
  getActiveSession,
  incrementDeletedMessages,
  getDeletedMessagesCount,
  getWarsawDateString,
  getCurrentWeekRange,
  getCurrentMonthRange
};
