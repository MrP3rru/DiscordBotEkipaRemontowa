require('dotenv').config();
const express = require('express');
const { 
  Client, 
  GatewayIntentBits, 
  ActivityType, 
  EmbedBuilder, 
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  PermissionFlagsBits, 
  ApplicationCommandOptionType,
  MessageFlags,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  UserSelectMenuBuilder,
  StringSelectMenuBuilder,
  ComponentType,
  Events
} = require('discord.js');
const db = require('./database');

// Zapobieganie wyłączaniu procesu przez nieobsłużone błędy
process.on('unhandledRejection', (reason, promise) => {
  console.warn('⚠️ [Ostrzeżenie] Nieobsłużone odrzucenie Promise:', reason?.message || reason);
});
process.on('uncaughtException', (error) => {
  console.error('⚠️ [Ostrzeżenie] Nieobsłużony wyjątek:', error?.message || error);
});

// --- GLOBALNE ZMIENNE STANU BOTA ---
const activeClearChannels = new Set();
let isAutoCleanEnabled = true;

// --- SERWER EXPRESS (Utrzymanie aktywności na Render) ---
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
  res.send({ status: 'ok', message: 'Bot Ekipa Remontowa jest aktywny!', discordReady: client.isReady() });
});

app.get('/healthz', (req, res) => {
  res.status(200).send('OK');
});

app.get('/diag', (req, res) => {
  const token = process.env.DISCORD_TOKEN;
  res.send({
    status: 'ok',
    discordReady: client.isReady(),
    botUser: client.user ? client.user.tag : null,
    hasToken: !!token && token !== 'twoj_token_bota_tutaj',
    tokenPrefix: token ? `${token.substring(0, 7)}...` : null,
    hasGuildId: !!process.env.GUILD_ID && process.env.GUILD_ID !== 'twoje_guild_id_tutaj',
    guildId: process.env.GUILD_ID,
    hasCleanChannelId: !!process.env.CLEAN_CHANNEL_ID,
    hasDatabaseUrl: !!process.env.DATABASE_URL && process.env.DATABASE_URL !== 'twój_connection_string_supabase_tutaj',
    timestamp: new Date().toISOString()
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Serwer HTTP nasłuchuje na porcie ${PORT} (0.0.0.0)`);
});


// --- INICJALIZACJA BOTA DISCORD ---
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

// Pomocnicza funkcja do formatowania czasu (ms -> tekst)
function formatDuration(ms) {
  if (!ms || ms <= 0) return '0 sek.';

  const seconds = Math.floor((ms / 1000) % 60);
  const minutes = Math.floor((ms / (1000 * 60)) % 60);
  const hours = Math.floor(ms / (1000 * 60 * 60));

  const parts = [];
  if (hours > 0) parts.push(`${hours} godz.`);
  if (minutes > 0) parts.push(`${minutes} min.`);
  if (seconds > 0 || parts.length === 0) parts.push(`${seconds} sek.`);

  return parts.join(' ');
}

// Krótkie formatowanie dużych liczb (np. 1000 -> 1k, 1250 -> 1.3k)
function formatNumberShort(num) {
  if (num < 1000) return num.toString();
  const thousands = num / 1000;
  if (num % 1000 === 0) return `${thousands}k`;
  return `${thousands.toFixed(1)}k`;
}

// Krótkie formatowanie czasu na potrzeby statusu bota
function formatDurationShort(ms) {
  if (!ms || ms <= 0) return '0m';
  const hours = Math.floor(ms / (1000 * 60 * 60));
  const minutes = Math.floor((ms / (1000 * 60)) % 60);
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  return `${minutes}m`;
}

// Etykieta okresu
function getPeriodLabel(period) {
  switch (period) {
    case 'today': return '📅 Dzisiaj';
    case 'week': return '📆 Ten tydzień';
    case 'month': return '🗓️ Ten miesiąc';
    case 'all':
    default: return '🏆 Łącznie (All-time)';
  }
}

// Funkcja aktualizująca status bota (Usunięte wiadomości) w czasie rzeczywistym
async function updatePresence() {
  try {
    const guildId = process.env.GUILD_ID;
    if (!guildId || guildId === 'twoje_guild_id_tutaj') {
      client.user.setActivity('brak konfiguracji GUILD_ID 🎙️', { type: ActivityType.Listening });
      return;
    }

    const deletedCount = await db.getDeletedMessagesCount();
    const formattedDeleted = formatNumberShort(deletedCount);
    const statusText = `🗑️ Usunięto: ${formattedDeleted}`;

    client.user.setPresence({
      activities: [{ 
        name: statusText,
        type: ActivityType.Custom,
        state: statusText
      }],
      status: 'online',
    });

    client.user.setActivity(statusText, { type: ActivityType.Custom });
  } catch (error) {
    console.error('Błąd podczas aktualizowania obecności bota:', error.message);
  }
}

// Funkcja aktualizująca opis aplikacji "O mnie" (Topka 3)
async function updateApplicationBio() {
  try {
    const guildId = process.env.GUILD_ID;
    if (!guildId || guildId === 'twoje_guild_id_tutaj') return;

    const leaderboardData = await db.getLeaderboard(guildId, 3, 0, 'all');
    const leaderboard = leaderboardData.entries;
    
    const bioLines = ['🏆 Topka aktywności głosowej:'];
    if (leaderboard.length === 0) {
      bioLines.push('Brak danych o aktywności.');
    } else {
      for (let i = 0; i < leaderboard.length; i++) {
        const row = leaderboard[i];
        const medal = i === 0 ? '🥇' : (i === 1 ? '🥈' : '🥉');
        let name = 'Nieznany';
        
        try {
          const userObj = await client.users.fetch(row.user_id);
          name = userObj.username;
        } catch (err) {
          name = `User-${row.user_id.substring(0, 4)}`;
        }
        
        const timeFormatted = formatDurationShort(row.total_time);
        bioLines.push(`${medal} ${name} (${timeFormatted})`);
      }
    }

    const bioText = bioLines.join('\n');
    
    if (client.application) {
      await client.application.edit({ description: bioText }).catch(() => null);
    }
  } catch (error) {
    // Cicha obsługa ewentualnego rate limitu Discorda
    console.warn('Ostrzeżenie podczas aktualizowania opisu bota (O mnie):', error.message);
  }
}

// Budowanie widoku rankingu (Embed + Przyciski nawigacji)
async function buildLeaderboardView(guildId, period = 'all', page = 1) {
  const limit = 10;
  const targetPage = Math.max(1, page);
  const offset = (targetPage - 1) * limit;

  const result = await db.getLeaderboard(guildId, limit, offset, period);
  const { entries, totalCount, totalPages } = result;
  const actualPage = Math.min(targetPage, totalPages);

  const periodLabel = getPeriodLabel(period);

  const embed = new EmbedBuilder()
    .setColor('#5865F2')
    .setTitle(`🏆 Ranking aktywności na kanałach głosowych`)
    .setDescription(`**Okres:** ${periodLabel}\n\n` + (entries.length === 0 
      ? '*Brak danych o aktywności dla wybranego okresu.*'
      : entries.map((row, index) => {
          const rankNumber = offset + index + 1;
          let rankBadge = `**#${rankNumber}**`;
          if (rankNumber === 1) rankBadge = '🥇';
          else if (rankNumber === 2) rankBadge = '🥈';
          else if (rankNumber === 3) rankBadge = '🥉';

          return `${rankBadge} <@${row.user_id}> — **${formatDuration(row.total_time)}**`;
        }).join('\n\n')
    ))
    .setFooter({ 
      text: `Strona ${actualPage} z ${totalPages} • Osób: ${totalCount} • Czas liczony od 25.06.2026 • Ekipa Remontowa` 
    })
    .setTimestamp();

  // Przyciski nawigacji stron
  const prevButton = new ButtonBuilder()
    .setCustomId(`lb_prev_${period}_${actualPage}`)
    .setLabel('◀ Poprzednia')
    .setStyle(ButtonStyle.Primary)
    .setDisabled(actualPage <= 1);

  const pageIndicator = new ButtonBuilder()
    .setCustomId(`lb_info_${period}_${actualPage}`)
    .setLabel(`Strona ${actualPage} / ${totalPages}`)
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(true);

  const nextButton = new ButtonBuilder()
    .setCustomId(`lb_next_${period}_${actualPage}`)
    .setLabel('Następna ▶')
    .setStyle(ButtonStyle.Primary)
    .setDisabled(actualPage >= totalPages);

  const row = new ActionRowBuilder().addComponents(prevButton, pageIndicator, nextButton);

  return { embeds: [embed], components: [row] };
}

// Obsługa uruchomienia bota
client.once(Events.ClientReady, async () => {
  console.log(`Zalogowano jako ${client.user.tag}!`);

  // Inicjalizacja bazy danych
  await db.initDatabase();

  // --- DIAGNOSTYKA UPRAWNIEŃ ---
  const guildId = process.env.GUILD_ID;
  const cleanChannelId = process.env.CLEAN_CHANNEL_ID;
  if (guildId && guildId !== 'twoje_guild_id_tutaj') {
    try {
      const guild = await client.guilds.fetch(guildId);
      console.log(`[Diagnostyka] Połączono z serwerem: ${guild.name}`);
      
      const channels = await guild.channels.fetch();
      const voiceChannels = channels.filter(c => c.isVoiceBased());
      console.log(`[Diagnostyka] Widoczne kanały głosowe (${voiceChannels.size}): ${voiceChannels.map(c => `#${c.name}`).join(', ') || 'Brak'}`);
      
      const hasCleanChannel = channels.has(cleanChannelId);
      if (hasCleanChannel) {
        const cleanChan = channels.get(cleanChannelId);
        console.log(`[Diagnostyka] ✅ Kanał do czyszczenia #${cleanChan.name} jest widoczny dla bota.`);
      } else {
        console.log(`[Diagnostyka] ❌ OSTRZEŻENIE: Kanał do czyszczenia o ID ${cleanChannelId} NIE jest widoczny dla bota! Sprawdź, czy ID jest poprawne i czy bot ma do niego dostęp.`);
      }

      // Inicjalizacja zarządzanych kanałów głosowych (pokoi prywatnych)
      await initManagedVoiceChannels(guild);
    } catch (err) {
      console.error('[Diagnostyka] Błąd pobierania danych o serwerze:', err.message);
    }
  }

  // Definicja komend Slash
  const commands = [
    {
      name: 'profile',
      description: 'Pokazuje szczegółowy profil aktywności głosowej użytkownika (dzisiaj, tydzień, miesiąc, łącznie).',
      options: [
        {
          name: 'uzytkownik',
          type: ApplicationCommandOptionType.User,
          description: 'Użytkownik, którego profil chcesz zobaczyć (domyślnie: Ty).',
          required: false
        }
      ]
    },
    {
      name: 'time',
      description: 'Pokazuje czas spędzony na kanałach głosowych.',
      options: [
        {
          name: 'uzytkownik',
          type: ApplicationCommandOptionType.User,
          description: 'Użytkownik, którego czas chcesz sprawdzić (opcjonalnie).',
          required: false
        },
        {
          name: 'okres',
          type: ApplicationCommandOptionType.String,
          description: 'Wybierz okres czasu (domyślnie: łącznie).',
          required: false,
          choices: [
            { name: '🏆 Łącznie (All-time)', value: 'all' },
            { name: '📅 Dzisiaj', value: 'today' },
            { name: '📆 Ten tydzień', value: 'week' },
            { name: '🗓️ Ten miesiąc', value: 'month' }
          ]
        }
      ]
    },
    {
      name: 'daily',
      description: 'Pokazuje czas spędzony na kanałach głosowych w dniu dzisiejszym.',
      options: [
        {
          name: 'uzytkownik',
          type: ApplicationCommandOptionType.User,
          description: 'Użytkownik, którego czas chcesz sprawdzić (opcjonalnie).',
          required: false
        }
      ]
    },
    {
      name: 'weekly',
      description: 'Pokazuje czas spędzony na kanałach głosowych w bieżącym tygodniu.',
      options: [
        {
          name: 'uzytkownik',
          type: ApplicationCommandOptionType.User,
          description: 'Użytkownik, którego czas chcesz sprawdzić (opcjonalnie).',
          required: false
        }
      ]
    },
    {
      name: 'monthly',
      description: 'Pokazuje czas spędzony na kanałach głosowych w bieżącym miesiącu.',
      options: [
        {
          name: 'uzytkownik',
          type: ApplicationCommandOptionType.User,
          description: 'Użytkownik, którego czas chcesz sprawdzić (opcjonalnie).',
          required: false
        }
      ]
    },
    {
      name: 'leaderboard',
      description: 'Pokazuje ranking użytkowników z największą ilością czasu na kanałach głosowych.',
      options: [
        {
          name: 'okres',
          type: ApplicationCommandOptionType.String,
          description: 'Wybierz okres rankingu (domyślnie: łącznie).',
          required: false,
          choices: [
            { name: '🏆 Łącznie (All-time)', value: 'all' },
            { name: '📅 Dzisiaj', value: 'today' },
            { name: '📆 Ten tydzień', value: 'week' },
            { name: '🗓️ Ten miesiąc', value: 'month' }
          ]
        },
        {
          name: 'strona',
          type: ApplicationCommandOptionType.Integer,
          description: 'Numer strony rankingu (np. 1, 2, 3...).',
          required: false,
          min_value: 1
        }
      ]
    },
    {
      name: 'clear',
      description: 'Usuwa wybraną liczbę wiadomości z obecnego kanału (Admin).',
      default_member_permissions: PermissionFlagsBits.ManageMessages.toString(),
      options: [
        {
          name: 'ilosc',
          type: ApplicationCommandOptionType.Integer,
          description: 'Liczba wiadomości do usunięcia (1-1000).',
          required: true,
          min_value: 1,
          max_value: 1000
        },
        {
          name: 'usun_bardzo_stare',
          type: ApplicationCommandOptionType.Boolean,
          description: 'Czy usuwać wiadomości starsze niż 14 dni (domyślnie: Tak)?',
          required: false
        },
        {
          name: 'opoznienie_sekundy',
          type: ApplicationCommandOptionType.Integer,
          description: 'Opóźnienie między usuwaniem starych wiadomości w sekundach (domyślnie 2, min 1, max 60).',
          required: false,
          min_value: 1,
          max_value: 60
        },
        {
          name: 'starsze_niz_minuty',
          type: ApplicationCommandOptionType.Integer,
          description: 'Usuń tylko wiadomości starsze niż X minut (np. 120 dla 2h).',
          required: false,
          min_value: 0
        }
      ]
    },
    {
      name: 'stop',
      description: 'Zatrzymuje aktywne powolne usuwanie wiadomości na tym kanale (Admin).',
      default_member_permissions: PermissionFlagsBits.ManageMessages.toString()
    },
    {
      name: 'autoclean',
      description: 'Włącza lub wyłącza automatyczne czyszczenie kanału (Admin).',
      default_member_permissions: PermissionFlagsBits.ManageMessages.toString(),
      options: [
        {
          name: 'status',
          type: ApplicationCommandOptionType.Boolean,
          description: 'Czy automatyczne czyszczenie ma być włączone?',
          required: true
        }
      ]
    }
  ];

  // Rejestracja komend Slash
  try {
    const guildId = process.env.GUILD_ID;
    if (guildId && guildId !== 'twoje_guild_id_tutaj') {
      const guild = await client.guilds.fetch(guildId);
      await guild.commands.set(commands);
      console.log(`Zarejestrowano komendy Slash lokalnie dla serwera: ${guild.name}`);
    } else {
      await client.application.commands.set(commands);
      console.log('Zarejestrowano komendy Slash globalnie.');
    }
  } catch (error) {
    console.error('Błąd podczas rejestracji komend Slash:', error.message);
  }

  // Uruchomienie pętli aktualizujących
  updatePresence();
  updateApplicationBio();
  setInterval(updatePresence, 30000); // co 30 sekund
  setInterval(updateApplicationBio, 300000); // co 5 minut (bezpiecznie przed rate limitem)
  setInterval(db.checkpointActiveSessions, 300000); // co 5 minut zapisywanie sesji w tle

  // Uruchomienie pętli automatycznego usuwania wiadomości
  startAutoCleanLoop();
});

// ============================================================================
// --- SYSTEM ZARZĄDZANIA PRYWATNYMI KANAŁAMI GŁOSOWYMI (CLAIM-TO-OWN) ---
// ============================================================================

// Pamięć podręczna stanu zarządzanych pokoi głosowych
const managedRooms = new Map();

// Pobranie listy ID skonfigurowanych kanałów zarządzanych z .env
function getManagedVoiceChannelIds() {
  const raw = process.env.MANAGED_VOICE_CHANNEL_IDS || '';
  return raw
    .split(',')
    .map(id => id.trim())
    .filter(id => id.length > 0 && id !== 'twoje_id_kanalu');
}

// Pobranie lub utworzenie obiektu stanu dla danego kanału
function getOrCreateRoom(channel) {
  if (!managedRooms.has(channel.id)) {
    managedRooms.set(channel.id, {
      channelId: channel.id,
      guildId: channel.guild.id,
      ownerId: null,
      defaultName: channel.name || '🔊 Pokój Prywatny',
      isPrivate: false,       // true = kanał ukryty dla @everyone
      isLocked: false,        // true = zakaz dołączania dla @everyone
      userLimit: channel.userLimit || 0,
      isMutedGuests: false,   // true = goście mają zakaz mówienia
      allowedUserIds: new Set(),
      blockedUserIds: new Set(),
      panelMessageId: null,
      claimedAt: null
    });
  }
  return managedRooms.get(channel.id);
}

// Bezpieczne ustawianie statusu głosowego kanału
async function setVoiceChannelStatus(channel, statusText) {
  try {
    if (typeof channel.setStatus === 'function') {
      await channel.setStatus(statusText || '');
    } else if (client.rest) {
      await client.rest.put(`/channels/${channel.id}/voice-status`, {
        body: { status: statusText || '' }
      }).catch(() => null);
    }
  } catch (err) {
    // Ciche ignorowanie, jeśli funkcja nie jest wspierana na danym poziomie serwera
  }
}

// Czyszczenie starych wiadomości bota na czacie kanału głosowego
async function cleanChannelChat(channel) {
  try {
    const messages = await channel.messages.fetch({ limit: 50 }).catch(() => null);
    if (!messages || messages.size === 0) return;
    const botMessages = messages.filter(m => m.author.id === client.user.id);
    if (botMessages.size > 0) {
      if (typeof channel.bulkDelete === 'function') {
        await channel.bulkDelete(botMessages, true).catch(() => null);
      } else {
        for (const msg of botMessages.values()) {
          await msg.delete().catch(() => null);
        }
      }
    }
  } catch (err) {
    // Cicha obsługa błędów czyszczenia
  }
}

// Bezpieczne ustawianie statusu głosowego kanału
async function setVoiceChannelStatus(channel, statusText) {
  try {
    if (typeof channel.setStatus === 'function') {
      await channel.setStatus(statusText || '');
    } else if (client.rest) {
      await client.rest.put(`/channels/${channel.id}/voice-status`, {
        body: { status: statusText || '' }
      }).catch(() => null);
    }
  } catch (err) {
    // Ciche ignorowanie, jeśli funkcja nie jest wspierana
  }
}

// Budowanie widoku Panelu Kontrolnego na czacie głosowym (Premium UI)
function buildRoomControlPanel(room, ownerMember, channel = null) {
  const ownerMention = ownerMember ? `<@${ownerMember.id}> (${ownerMember.displayName})` : 'Brak';
  const membersCount = channel ? channel.members.filter(m => !m.user.bot).size : 1;
  const limitDisplay = room.userLimit > 0 ? `👥 **${membersCount} / ${room.userLimit}** osób` : `👥 **${membersCount}** (brak limitu)`;

  const visBadge = room.isPrivate ? '🔴 `[ 🔒 UKRYTY - PRYWATNY ]`' : '🟢 `[ 🌐 WIDOCZNY - PUBLICZNY ]`';
  const lockBadge = room.isLocked ? '🔴 `[ ⛔ ZABLOKOWANY ]`' : '🟢 `[ 🔓 OTWARTY DLA WSZYSTKICH ]`';
  const micBadge = room.isMutedGuests ? '🔴 `[ 🔇 TYLKO GOSPODARZ MÓWI ]`' : '🟢 `[ 🎙️ SWOBODNA ROZMOWA ]`';

  const embed = new EmbedBuilder()
    .setColor(room.isPrivate ? '#ED4245' : '#5865F2')
    .setTitle('🎛️ PANEL DOWODZENIA POKOJEM GŁOSOWYM')
    .setDescription(
      `Witaj w centrum zarządzania swoim pokojem głosowym! Jako **Gospodarz** możesz swobodnie nim sterować.\n\n` +
      `👑 **Gospodarz pokoju:** ${ownerMention}\n` +
      `👥 **Obecni w pokoju:** ${limitDisplay}\n\n` +
      `**AKTUALNY STAN POKOJU:**\n` +
      `> 👁️ **Widoczność:** ${visBadge}\n` +
      `> 🚪 **Dostęp do pokoju:** ${lockBadge}\n` +
      `> 🎤 **Mikrofony gości:** ${micBadge}\n\n` +
      `*Kliknij wybrany przycisk poniżej, aby natychmiast zmienić ustawienie:*`
    )
    .setFooter({ text: 'Ekipa Remontowa • Pokój Prywatny • Sterowanie' })
    .setTimestamp();

  // Rząd 1: Główne przełączniki i modale
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`mv_btn_vis_${room.channelId}`)
      .setLabel(room.isPrivate ? 'Pokaż kanał' : 'Ukryj kanał')
      .setEmoji(room.isPrivate ? '👁️' : '🕶️')
      .setStyle(room.isPrivate ? ButtonStyle.Success : ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`mv_btn_lock_${room.channelId}`)
      .setLabel(room.isLocked ? 'Odblokuj wejście' : 'Zablokuj wejście')
      .setEmoji(room.isLocked ? '🔓' : '🔒')
      .setStyle(room.isLocked ? ButtonStyle.Success : ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`mv_btn_limit_${room.channelId}`)
      .setLabel('Limit osób')
      .setEmoji('👥')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`mv_btn_rename_${room.channelId}`)
      .setLabel('Zmień nazwę')
      .setEmoji('✏️')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`mv_btn_status_${room.channelId}`)
      .setLabel('Status')
      .setEmoji('💬')
      .setStyle(ButtonStyle.Primary)
  );

  // Rząd 2: Ludzie, wyciszanie i reset
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`mv_btn_mute_${room.channelId}`)
      .setLabel(room.isMutedGuests ? 'Odcisz gości' : 'Wycisz gości')
      .setEmoji(room.isMutedGuests ? '🔊' : '🔇')
      .setStyle(room.isMutedGuests ? ButtonStyle.Success : ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(`mv_btn_invite_${room.channelId}`)
      .setLabel('Zaproś znajomego')
      .setEmoji('➕')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`mv_btn_kick_${room.channelId}`)
      .setLabel('Wyrzuć / Zablokuj')
      .setEmoji('🚫')
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(`mv_btn_transfer_${room.channelId}`)
      .setLabel('Przekaż koronę')
      .setEmoji('👑')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`mv_btn_reset_${room.channelId}`)
      .setLabel('Resetuj pokój')
      .setEmoji('🔄')
      .setStyle(ButtonStyle.Secondary)
  );

  return { embeds: [embed], components: [row1, row2] };
}

// Odświeżenie wiadomości panelu na czacie kanału
async function refreshPanelMessage(channel, room, ownerMember) {
  try {
    if (!room.panelMessageId) return;
    const panelMsg = await channel.messages.fetch(room.panelMessageId).catch(() => null);
    if (panelMsg) {
      const panel = buildRoomControlPanel(room, ownerMember, channel);
      await panelMsg.edit(panel).catch(() => null);
    }
  } catch (err) {
    // Ignoruj błędy
  }
}

// Synchronizacja uprawnień kanału Discord zgodnie ze stanem pokoju
async function syncRoomPermissions(channel, room) {
  try {
    const overwrites = [];

    // Uprawnienia Bota (zawsze pełna kontrola)
    overwrites.push({
      id: client.user.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.Connect,
        PermissionFlagsBits.Speak,
        PermissionFlagsBits.ManageChannels,
        PermissionFlagsBits.ManageRoles,
        PermissionFlagsBits.MoveMembers,
        PermissionFlagsBits.MuteMembers,
        PermissionFlagsBits.DeafenMembers,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.EmbedLinks
      ]
    });

    // Uprawnienia dla @everyone
    const everyoneAllow = [];
    const everyoneDeny = [];

    if (room.isPrivate) {
      everyoneDeny.push(PermissionFlagsBits.ViewChannel);
      everyoneDeny.push(PermissionFlagsBits.Connect);
    } else {
      everyoneAllow.push(PermissionFlagsBits.ViewChannel);
      if (room.isLocked) {
        everyoneDeny.push(PermissionFlagsBits.Connect);
      } else {
        everyoneAllow.push(PermissionFlagsBits.Connect);
      }
    }

    if (room.isMutedGuests) {
      everyoneDeny.push(PermissionFlagsBits.Speak);
      everyoneDeny.push(PermissionFlagsBits.UseVAD);
    }

    overwrites.push({
      id: channel.guild.roles.everyone.id,
      allow: everyoneAllow,
      deny: everyoneDeny
    });

    // Uprawnienia Gospodarza (Właściciela)
    if (room.ownerId) {
      overwrites.push({
        id: room.ownerId,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.Connect,
          PermissionFlagsBits.Speak,
          PermissionFlagsBits.MoveMembers,
          PermissionFlagsBits.MuteMembers,
          PermissionFlagsBits.DeafenMembers,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory,
          PermissionFlagsBits.EmbedLinks,
          PermissionFlagsBits.AttachFiles
        ]
      });
    }

    // Uprawnienia dla zaproszonych użytkowników (Biała lista)
    for (const userId of room.allowedUserIds) {
      if (userId === room.ownerId) continue;
      const allowPerms = [
        PermissionFlagsBits.ViewChannel, 
        PermissionFlagsBits.Connect,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory
      ];
      const denyPerms = [];
      if (room.isMutedGuests) {
        denyPerms.push(PermissionFlagsBits.Speak);
      } else {
        allowPerms.push(PermissionFlagsBits.Speak);
      }

      overwrites.push({
        id: userId,
        allow: allowPerms,
        deny: denyPerms
      });
    }

    // Uprawnienia dla zablokowanych użytkowników (Czarna lista)
    for (const userId of room.blockedUserIds) {
      if (userId === room.ownerId) continue;
      overwrites.push({
        id: userId,
        deny: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.Connect
        ]
      });
    }

    await channel.permissionOverwrites.set(overwrites);
  } catch (err) {
    console.error(`[ManagedVoice] ⚠️ Błąd synchronizacji uprawnień na kanale #${channel.name}: ${err.message}`);
  }
}

// Przejęcie kanału przez pierwszego użytkownika
async function claimRoom(channel, member) {
  const room = getOrCreateRoom(channel);
  room.ownerId = member.id;
  room.isPrivate = true; // domyślnie ukryty dla reszty serwera
  room.isLocked = false;
  room.userLimit = 0;
  room.isMutedGuests = false;
  room.allowedUserIds.clear();
  room.blockedUserIds.clear();
  room.claimedAt = Date.now();

  console.log(`[ManagedVoice] Użytkownik ${member.user.tag} został Gospodarzem kanału #${channel.name}.`);

  // Wyczyść stare wiadomości z czatu kanału przed wysłaniem nowego panelu
  await cleanChannelChat(channel);

  const targetName = `🔒 Kanał: ${member.displayName}`;

  await Promise.allSettled([
    channel.edit({ name: targetName }),
    setVoiceChannelStatus(channel, `Gospodarz: ${member.displayName}`),
    syncRoomPermissions(channel, room)
  ]);

  // Wysłanie nowego panelu na czat głosowy
  try {
    const panelPayload = buildRoomControlPanel(room, member, channel);
    const msg = await channel.send({
      content: `👋 Witaj <@${member.id}>! Oto Twój prywatny panel kontrolny pokoju:`,
      ...panelPayload
    });
    room.panelMessageId = msg.id;
  } catch (err) {
    console.error('[ManagedVoice] Błąd wysyłania panelu na czat:', err.message);
  }
}


// Przekazanie własności innemu użytkownikowi (automatyczne lub ręczne)
async function transferRoomOwnership(channel, newOwnerMember, isAutomatic = true) {
  const room = getOrCreateRoom(channel);
  room.ownerId = newOwnerMember.id;
  room.allowedUserIds.delete(newOwnerMember.id);

  console.log(`[ManagedVoice] Gospodarz kanału #${channel.name} zmieniony na ${newOwnerMember.user.tag}.`);

  const targetName = `🔒 Kanał: ${newOwnerMember.displayName}`;

  // Jeśli nowy gospodarz był wyciszony przez tryb wykładu, odcisz go
  await newOwnerMember.voice.setMute(false).catch(() => null);

  await Promise.allSettled([
    channel.edit({ name: targetName }),
    setVoiceChannelStatus(channel, `Gospodarz: ${newOwnerMember.displayName}`),
    syncRoomPermissions(channel, room)
  ]);

  // Usunięcie starych paneli i wysłanie świeżego
  await cleanChannelChat(channel);

  try {
    const panelPayload = buildRoomControlPanel(room, newOwnerMember, channel);
    const reasonText = isAutomatic ? '(poprzedni gospodarz opuścił pokój)' : '(własność została przekazana)';
    const msg = await channel.send({
      content: `👑 **Nowy Gospodarz:** <@${newOwnerMember.id}> przejął zarządzanie tym pokojem ${reasonText}!`,
      ...panelPayload
    });
    room.panelMessageId = msg.id;
  } catch (err) {
    console.error('[ManagedVoice] Błąd aktualizacji panelu po zmianie gospodarza:', err.message);
  }
}

// Błyskawiczny reset kanału do stanu wyjściowego (gdy wszyscy opuszczą pokój)
async function resetManagedRoom(channel) {
  const room = getOrCreateRoom(channel);
  room.ownerId = null;
  room.isPrivate = false;
  room.isLocked = false;
  room.userLimit = 0;
  room.isMutedGuests = false;
  room.allowedUserIds.clear();
  room.blockedUserIds.clear();
  room.claimedAt = null;
  room.panelMessageId = null;

  console.log(`[ManagedVoice] ⚡ Błyskawiczny reset kanału #${channel.name} do stanu początkowego.`);

  // Równoległe wykonanie wszystkich operacji czyszczących (szybkość 50%+ wyższa)
  await Promise.allSettled([
    channel.edit({ 
      name: room.defaultName || '🔊 Pokój Prywatny', 
      userLimit: 0 
    }).catch(() => null),
    setVoiceChannelStatus(channel, ''),
    channel.permissionOverwrites.set([
      {
        id: channel.guild.roles.everyone.id,
        allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.Speak]
      },
      {
        id: client.user.id,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.Connect,
          PermissionFlagsBits.Speak,
          PermissionFlagsBits.ManageChannels,
          PermissionFlagsBits.ManageRoles,
          PermissionFlagsBits.MoveMembers,
          PermissionFlagsBits.MuteMembers,
          PermissionFlagsBits.SendMessages
        ]
      }
    ]).catch(() => null),
    cleanChannelChat(channel)
  ]);
}

// Inicjalizacja zarządzanych kanałów przy starcie bota
async function initManagedVoiceChannels(guild) {
  const managedIds = getManagedVoiceChannelIds();
  if (managedIds.length === 0) return;

  console.log(`[ManagedVoice] Inicjalizacja ${managedIds.length} zarządzanych kanałów głosowych...`);
  for (const chanId of managedIds) {
    try {
      const channel = await guild.channels.fetch(chanId).catch(() => null);
      if (channel && channel.isVoiceBased()) {
        const room = getOrCreateRoom(channel);
        room.defaultName = channel.name;

        const nonBots = channel.members.filter(m => !m.user.bot);
        if (nonBots.size === 0) {
          console.log(`[ManagedVoice] Kanał #${channel.name} (${chanId}) jest pusty. Ustawiam stan domyślny.`);
          await resetManagedRoom(channel);
        } else {
          const firstMember = nonBots.first();
          console.log(`[ManagedVoice] Kanał #${channel.name} (${chanId}) ma obecnych użytkowników. Przypisuję gospodarza: ${firstMember.user.tag}.`);
          await claimRoom(channel, firstMember);
        }
      } else {
        console.warn(`[ManagedVoice] ⚠️ Kanał o ID ${chanId} nie istnieje lub nie jest kanałem głosowym!`);
      }
    } catch (err) {
      console.warn(`[ManagedVoice] Błąd inicjalizacji kanału ${chanId}:`, err.message);
    }
  }
}

// Obsługa zdarzeń głosowych dla kanałów zarządzanych (Strict Isolation)
async function handleManagedVoiceStateUpdate(oldState, newState) {
  try {
    const managedIds = getManagedVoiceChannelIds();
    if (managedIds.length === 0) return;

    const oldChannelId = oldState.channelId;
    const newChannelId = newState.channelId;

    const isOldManaged = oldChannelId && managedIds.includes(oldChannelId);
    const isNewManaged = newChannelId && managedIds.includes(newChannelId);

    // GWARANCJA BEZPIECZEŃSTWA: Jeżeli zdarzenie nie dotyczy żadnego zarządzanego kanału, natychmiast kończymy!
    if (!isOldManaged && !isNewManaged) {
      return;
    }

    const member = newState.member || oldState.member;
    if (!member || member.user.bot) return;

    // 1. Użytkownik wszedł na zarządzany kanał
    if (isNewManaged && oldChannelId !== newChannelId) {
      const channel = newState.channel;
      if (channel) {
        const room = getOrCreateRoom(channel);
        const nonBotMembers = channel.members.filter(m => !m.user.bot);

        if (!room.ownerId || nonBotMembers.size <= 1) {
          await claimRoom(channel, member);
        } else {
          // Jeśli ktoś dołączył do aktywnego pokoju i włączone jest wyciszenie gości -> wycisz go na serwerze!
          if (room.isMutedGuests && member.id !== room.ownerId) {
            await member.voice.setMute(true).catch(() => null);
          }
          const ownerMember = room.ownerId ? channel.members.get(room.ownerId) : null;
          await refreshPanelMessage(channel, room, ownerMember);
        }
      }
    }

    // 2. Użytkownik opuścił zarządzany kanał
    if (isOldManaged && oldChannelId !== newChannelId) {
      const channel = oldState.channel || await client.channels.fetch(oldChannelId).catch(() => null);
      if (channel) {
        const room = getOrCreateRoom(channel);
        // Kluczowe: wykluczamy użytkownika, który WŁAŚNIE OPUŚCIŁ kanał (discord.js cache może go jeszcze trzymać)
        const remainingNonBots = channel.members.filter(m => !m.user.bot && m.id !== member.id);

        if (remainingNonBots.size === 0) {
          await resetManagedRoom(channel);
        } else if (room.ownerId === member.id) {
          // Właściciel wyszedł, ale są inni ludzie -> losujemy nowego gospodarza
          const candidates = Array.from(remainingNonBots.values());
          const randomNewOwner = candidates[Math.floor(Math.random() * candidates.length)];
          await transferRoomOwnership(channel, randomNewOwner, true);
        } else {
          const ownerMember = room.ownerId ? channel.members.get(room.ownerId) : null;
          await refreshPanelMessage(channel, room, ownerMember);
        }
      }
    }
  } catch (err) {
    console.error('[ManagedVoice] Błąd w handleManagedVoiceStateUpdate:', err.message);
  }
}


// Obsługa interakcji z panelem prywatnego pokoju (Przyciski, Modale, Menu wyboru)
async function handleManagedVoiceInteraction(interaction) {
  const { customId, guild, user, member } = interaction;
  if (!customId || !customId.startsWith('mv_')) return false;

  try {
    const parts = customId.split('_'); // np. ['mv', 'btn', 'vis', channelId] lub ['mv', 'modal', 'rename', channelId]
    const actionType = parts[1]; // 'btn', 'modal', 'select', 'userselect'
    const actionName = parts[2]; // 'vis', 'lock', 'limit', 'rename', 'status', 'mute', 'invite', 'kick', 'transfer', 'reset'
    const channelId = parts.slice(3).join('_');

    const channel = await guild.channels.fetch(channelId).catch(() => null);
    if (!channel || !channel.isVoiceBased()) {
      await interaction.reply({ content: 'Nie odnaleziono powiązanego kanału głosowego.', flags: [MessageFlags.Ephemeral] });
      return true;
    }

    const room = getOrCreateRoom(channel);

    // Sprawdzenie uprawnień: Tylko gospodarz lub Administrator serwera
    const isOwner = room.ownerId === user.id;
    const isAdmin = member.permissions.has(PermissionFlagsBits.Administrator);

    if (!isOwner && !isAdmin) {
      await interaction.reply({
        content: `⛔ Tylko obecny **Gospodarz** tego kanału (${room.ownerId ? `<@${room.ownerId}>` : 'Brak'}) lub administrator może zmieniać jego ustawienia!`,
        flags: [MessageFlags.Ephemeral]
      });
      return true;
    }

    const ownerMember = room.ownerId ? (channel.members.get(room.ownerId) || await guild.members.fetch(room.ownerId).catch(() => null)) : null;

    // --- OBSŁUGA PRZYCISKÓW ---
    if (actionType === 'btn') {
      if (actionName === 'vis') {
        await interaction.deferUpdate().catch(() => null);
        room.isPrivate = !room.isPrivate;
        await syncRoomPermissions(channel, room);
        const panel = buildRoomControlPanel(room, ownerMember, channel);
        await interaction.editReply(panel).catch(() => null);
        return true;
      }

      if (actionName === 'lock') {
        await interaction.deferUpdate().catch(() => null);
        room.isLocked = !room.isLocked;
        await syncRoomPermissions(channel, room);
        const panel = buildRoomControlPanel(room, ownerMember, channel);
        await interaction.editReply(panel).catch(() => null);
        return true;
      }

      if (actionName === 'mute') {
        await interaction.deferUpdate().catch(() => null);
        room.isMutedGuests = !room.isMutedGuests;
        
        // Aktywny serwerowy mute / unmute wszystkich obecnych gości
        const guests = channel.members.filter(m => !m.user.bot && m.id !== room.ownerId);
        for (const guest of guests.values()) {
          await guest.voice.setMute(room.isMutedGuests).catch(() => null);
        }

        await syncRoomPermissions(channel, room);
        const panel = buildRoomControlPanel(room, ownerMember, channel);
        await interaction.editReply(panel).catch(() => null);
        return true;
      }

      if (actionName === 'reset') {
        await interaction.deferUpdate().catch(() => null);
        room.isPrivate = false;
        room.isLocked = false;
        room.userLimit = 0;
        room.isMutedGuests = false;
        room.allowedUserIds.clear();
        room.blockedUserIds.clear();

        // Odcisz wszystkich gości
        const guests = channel.members.filter(m => !m.user.bot);
        for (const guest of guests.values()) {
          await guest.voice.setMute(false).catch(() => null);
        }

        await channel.edit({ userLimit: 0 }).catch(() => null);
        await syncRoomPermissions(channel, room);
        const panel = buildRoomControlPanel(room, ownerMember, channel);
        await interaction.editReply(panel).catch(() => null);
        return true;
      }

      if (actionName === 'rename') {
        const modal = new ModalBuilder()
          .setCustomId(`mv_modal_rename_${channelId}`)
          .setTitle('✏️ Zmień nazwę pokoju głosowego');

        const input = new TextInputBuilder()
          .setCustomId('mv_input_name')
          .setLabel('Nowa nazwa kanału')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('np. 🎮 Pokój graczy')
          .setValue(channel.name)
          .setMaxLength(32)
          .setRequired(true);

        modal.addComponents(new ActionRowBuilder().addComponents(input));
        await interaction.showModal(modal);
        return true;
      }

      if (actionName === 'limit') {
        const modal = new ModalBuilder()
          .setCustomId(`mv_modal_limit_${channelId}`)
          .setTitle('👥 Ustaw limit osób w pokoju');

        const input = new TextInputBuilder()
          .setCustomId('mv_input_limit')
          .setLabel('Limit osób (0 = brak limitu, max 99)')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('np. 6')
          .setValue(room.userLimit.toString())
          .setMaxLength(2)
          .setRequired(true);

        modal.addComponents(new ActionRowBuilder().addComponents(input));
        await interaction.showModal(modal);
        return true;
      }

      if (actionName === 'status') {
        const modal = new ModalBuilder()
          .setCustomId(`mv_modal_status_${channelId}`)
          .setTitle('💬 Zmień status kanału głosowego');

        const input = new TextInputBuilder()
          .setCustomId('mv_input_status')
          .setLabel('Status pokoju (np. Gramy w CS2)')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('Wpisz status pokoju...')
          .setMaxLength(500)
          .setRequired(false);

        modal.addComponents(new ActionRowBuilder().addComponents(input));
        await interaction.showModal(modal);
        return true;
      }

      if (actionName === 'invite') {
        const selectMenu = new UserSelectMenuBuilder()
          .setCustomId(`mv_select_invite_${channelId}`)
          .setPlaceholder('🔍 Wybierz gracza z serwera do zaproszenia...')
          .setMinValues(1)
          .setMaxValues(1);

        const row = new ActionRowBuilder().addComponents(selectMenu);
        await interaction.reply({
          content: '➕ **Zaproś znajomego:** Wybierz osobę z serwera, która ma otrzymać pełny wstęp i widoczność pokoju:',
          components: [row],
          flags: [MessageFlags.Ephemeral]
        });
        return true;
      }

      if (actionName === 'kick') {
        const otherMembers = Array.from(channel.members.filter(m => !m.user.bot && m.id !== room.ownerId).values());
        
        if (otherMembers.length > 0) {
          const selectMenu = new StringSelectMenuBuilder()
            .setCustomId(`mv_select_kick_${channelId}`)
            .setPlaceholder('🚫 Wybierz osobę obecną w pokoju do wyrzucenia...')
            .addOptions(
              otherMembers.map(m => ({
                label: m.displayName.substring(0, 25),
                description: `@${m.user.username}`.substring(0, 50),
                value: m.id,
                emoji: '👢'
              }))
            );

          const row = new ActionRowBuilder().addComponents(selectMenu);
          await interaction.reply({
            content: '🚫 **Wyrzucenie z pokoju:** Wybierz osobę obecną w pokoju, którą chcesz natychmiast odłączyć i zablokować:',
            components: [row],
            flags: [MessageFlags.Ephemeral]
          });
        } else {
          // Jeśli nikt inny nie siedzi w pokoju, pozwól zablokować dowolnego użytkownika z serwera
          const selectMenu = new UserSelectMenuBuilder()
            .setCustomId(`mv_userselect_kick_${channelId}`)
            .setPlaceholder('🔍 Wybierz użytkownika z serwera do zablokowania...')
            .setMinValues(1)
            .setMaxValues(1);

          const row = new ActionRowBuilder().addComponents(selectMenu);
          await interaction.reply({
            content: '🚫 **Zablokuj użytkownika:** W pokoju nikogo innego nie ma. Wybierz osobę z serwera, aby zablokować jej wstęp:',
            components: [row],
            flags: [MessageFlags.Ephemeral]
          });
        }
        return true;
      }

      if (actionName === 'transfer') {
        const otherMembers = Array.from(channel.members.filter(m => !m.user.bot && m.id !== room.ownerId).values());
        
        if (otherMembers.length === 0) {
          await interaction.reply({
            content: 'ℹ️ **Jesteś jedyną osobą w tym pokoju!**\nAby przekazać komuś koronę, najpierw zaproś lub poczekaj, aż ktoś wejdzie do Twojego pokoju.',
            flags: [MessageFlags.Ephemeral]
          });
          return true;
        }

        const selectMenu = new StringSelectMenuBuilder()
          .setCustomId(`mv_select_transfer_${channelId}`)
          .setPlaceholder('👑 Wybierz osobę z pokoju, która ma zostać nowym Gospodarzem...')
          .addOptions(
            otherMembers.map(m => ({
              label: m.displayName.substring(0, 25),
              description: `@${m.user.username}`.substring(0, 50),
              value: m.id,
              emoji: '👤'
            }))
          );

        const row = new ActionRowBuilder().addComponents(selectMenu);
        await interaction.reply({
          content: '👑 **Przekaż Koronę:** Wybierz osobę obecną w Twoim pokoju głosowym:',
          components: [row],
          flags: [MessageFlags.Ephemeral]
        });
        return true;
      }
    }

    // --- OBSŁUGA MODALI ---
    if (actionType === 'modal') {
      if (actionName === 'rename') {
        const newName = interaction.fields.getTextInputValue('mv_input_name').trim();
        if (!newName) {
          await interaction.reply({ content: 'Nazwa nie może być pusta.', flags: [MessageFlags.Ephemeral] });
          return true;
        }

        await interaction.deferReply({ flags: [MessageFlags.Ephemeral] }).catch(() => null);

        try {
          await channel.edit({ name: newName });
          await refreshPanelMessage(channel, room, ownerMember);
          await interaction.editReply({ content: `✅ Nazwa kanału została zmieniona na: **${newName}**` }).catch(() => null);
        } catch (err) {
          await interaction.editReply({
            content: `⚠️ Nie udało się zmienić nazwy (${err.message}). Discord ogranicza zbyt częstą zmianę nazwy kanału (maks. 2 razy na 10 minut).`
          }).catch(() => null);
        }
        return true;
      }

      if (actionName === 'limit') {
        const limitRaw = interaction.fields.getTextInputValue('mv_input_limit').trim();
        const limitNum = parseInt(limitRaw, 10);

        if (isNaN(limitNum) || limitNum < 0 || limitNum > 99) {
          await interaction.reply({ content: 'Podaj poprawną liczbę od 0 do 99 (gdzie 0 to brak limitu).', flags: [MessageFlags.Ephemeral] });
          return true;
        }

        await interaction.deferReply({ flags: [MessageFlags.Ephemeral] }).catch(() => null);

        room.userLimit = limitNum;
        try {
          await channel.edit({ userLimit: limitNum });
        } catch (err) {
          console.warn('[ManagedVoice] Błąd ustawiania limitu osób:', err.message);
        }

        await refreshPanelMessage(channel, room, ownerMember);

        await interaction.editReply({
          content: `✅ Limit osób na kanale został ustawiony na: **${limitNum === 0 ? 'Brak limitu' : `${limitNum} osób`}**`
        }).catch(() => null);
        return true;
      }

      if (actionName === 'status') {
        const newStatus = interaction.fields.getTextInputValue('mv_input_status').trim();
        await interaction.deferReply({ flags: [MessageFlags.Ephemeral] }).catch(() => null);

        await setVoiceChannelStatus(channel, newStatus);
        await refreshPanelMessage(channel, room, ownerMember);
        await interaction.editReply({
          content: `✅ Status głosowy kanału został zaktualizowany na: **${newStatus || '(wyczyszczony)'}**`
        }).catch(() => null);
        return true;
      }
    }

    // --- OBSŁUGA MENU WYBORU (SELECT / USERSELECT) ---
    if (actionType === 'select' || actionType === 'userselect') {
      const targetUserId = interaction.values[0];
      await interaction.deferUpdate().catch(() => null);

      if (actionName === 'invite') {
        room.allowedUserIds.add(targetUserId);
        room.blockedUserIds.delete(targetUserId);
        await syncRoomPermissions(channel, room);
        await refreshPanelMessage(channel, room, ownerMember);

        await interaction.editReply({
          content: `✅ Pomyślnie nadano dostęp i widoczność dla użytkownika <@${targetUserId}>! Może teraz bez przeszkód dołączyć do Twojego pokoju.`,
          components: []
        }).catch(() => null);
        return true;
      }

      if (actionName === 'kick') {
        if (targetUserId === room.ownerId) {
          await interaction.editReply({
            content: `❌ Nie możesz wyrzucić samego siebie!`,
            components: []
          }).catch(() => null);
          return true;
        }

        room.blockedUserIds.add(targetUserId);
        room.allowedUserIds.delete(targetUserId);
        await syncRoomPermissions(channel, room);
        await refreshPanelMessage(channel, room, ownerMember);

        // Rozłączenie użytkownika z kanału jeśli jest połączony
        const targetMember = channel.members.get(targetUserId);
        if (targetMember && targetMember.voice) {
          await targetMember.voice.disconnect().catch(() => null);
        }

        await interaction.editReply({
          content: `🚫 Użytkownik <@${targetUserId}> został natychmiast wyrzucony i zablokowany przed wejściem na ten kanał.`,
          components: []
        }).catch(() => null);
        return true;
      }

      if (actionName === 'transfer') {
        if (targetUserId === room.ownerId) {
          await interaction.editReply({
            content: `ℹ️ Ten użytkownik jest już Gospodarzem tego pokoju!`,
            components: []
          }).catch(() => null);
          return true;
        }

        const targetMember = channel.members.get(targetUserId) || await guild.members.fetch(targetUserId).catch(() => null);
        if (!targetMember) {
          await interaction.editReply({
            content: `❌ Nie znaleziono wybranego użytkownika.`,
            components: []
          }).catch(() => null);
          return true;
        }

        await transferRoomOwnership(channel, targetMember, false);
        await interaction.editReply({
          content: `👑 Pomyślnie przekazano rolę Gospodarza użytkownikowi <@${targetUserId}>!`,
          components: []
        }).catch(() => null);
        return true;
      }
    }

    return true;
  } catch (err) {
    console.error('[ManagedVoice] Błąd podczas obsługi interakcji:', err);
    return true;
  }
}


// --- REJESTROWANIE CZASU NA KANAŁACH GŁOSOWYCH & OBSŁUGA POKOI PRYWATNYCH ---
client.on('voiceStateUpdate', async (oldState, newState) => {
  try {
    const member = newState.member || oldState.member;
    if (!member || member.user.bot) return;

    const userId = member.id;
    const guildId = newState.guild?.id || oldState.guild?.id;

    const joinedChannel = !oldState.channelId && newState.channelId;
    const leftChannel = oldState.channelId && !newState.channelId;
    const switchedChannel = oldState.channelId && newState.channelId && oldState.channelId !== newState.channelId;

    if (joinedChannel) {
      await db.startVoiceSession(userId, guildId, newState.channelId);
      console.log(`[Voice] ${member.user.tag} dołączył do kanału głosowego #${newState.channel?.name || newState.channelId}.`);
    } else if (leftChannel) {
      await db.endVoiceSession(userId, guildId);
      console.log(`[Voice] ${member.user.tag} opuścił kanał głosowy.`);
    } else if (switchedChannel) {
      await db.endVoiceSession(userId, guildId);
      await db.startVoiceSession(userId, guildId, newState.channelId);
      console.log(`[Voice] ${member.user.tag} zmienił kanał na #${newState.channel?.name || newState.channelId}.`);
    }

    // Obsługa prywatnych/zarządzanych kanałów głosowych (Claim-to-Own)
    await handleManagedVoiceStateUpdate(oldState, newState);
  } catch (err) {
    console.error('Błąd w zdarzeniu voiceStateUpdate:', err.message);
  }
});

// --- OBSŁUGA INTERAKCJI (KOMEND SLASH, PRZYCISKÓW, MODALI, MENU) ---
client.on('interactionCreate', async (interaction) => {
  try {
    // 1. OBSŁUGA INTERAKCJI POKOJU PRYWATNEGO (Przycisk, Modal, SelectMenu)
    const isManagedVoice = await handleManagedVoiceInteraction(interaction);
    if (isManagedVoice) return;

    // 2. OBSŁUGA PRZYCISKÓW PAGINACJI LEADERBOARD
    if (interaction.isButton()) {
      const { customId, guildId } = interaction;
      if (customId.startsWith('lb_prev_') || customId.startsWith('lb_next_')) {
        const parts = customId.split('_'); // ['lb', 'prev'/'next', period, page]
        const direction = parts[1];
        const period = parts[2];
        let currentPage = parseInt(parts[3], 10) || 1;

        const newPage = direction === 'prev' ? Math.max(1, currentPage - 1) : currentPage + 1;
        const view = await buildLeaderboardView(guildId, period, newPage);

        return await interaction.update(view);
      }
      return;
    }

    if (!interaction.isChatInputCommand()) return;

    const { commandName, options, guildId, user } = interaction;

    // --- KOMENDA /profile ---
    if (commandName === 'profile') {
      await interaction.deferReply();

      const targetUser = options.getUser('uzytkownik') || user;
      const member = interaction.guild?.members.cache.get(targetUser.id) || await interaction.guild?.members.fetch(targetUser.id).catch(() => null);
      
      const stats = await db.getUserStats(targetUser.id, guildId);

      let voiceStatus = '⚪ **Status:** Poza kanałem głosowym';
      if (stats.activeSession) {
        const channelMention = stats.activeSession.channel_id ? `<#${stats.activeSession.channel_id}>` : 'kanał głosowy';
        const joinUnix = Math.floor(stats.activeSession.join_time / 1000);
        const currentSessionDuration = Date.now() - stats.activeSession.join_time;
        voiceStatus = 
          `🟢 **Status:** Na kanale ${channelMention}\n` +
          `⏱️ **Bieżąca sesja:** od **<t:${joinUnix}:t>** (<t:${joinUnix}:R>) • trwa: **${formatDuration(currentSessionDuration)}**`;
      }

      const formatRank = (r) => (r ? `#${r}` : '-');

      const embed = new EmbedBuilder()
        .setColor(member?.displayHexColor && member.displayHexColor !== '#000000' ? member.displayHexColor : '#5865F2')
        .setAuthor({ 
          name: `Profil Aktywności: ${targetUser.username}`, 
          iconURL: targetUser.displayAvatarURL({ dynamic: true }) 
        })
        .setThumbnail(targetUser.displayAvatarURL({ dynamic: true, size: 256 }))
        .setDescription(
          `${voiceStatus}\n\n` +
          `📊 **Statystyki czasu spędzonego na rozmowach:**`
        )
        .addFields(
          {
            name: '📅 Dzisiaj',
            value: `⏱️ **${formatDuration(stats.today)}**\n🏆 Pozycja: **${formatRank(stats.ranks.today)}**`,
            inline: true
          },
          {
            name: '📆 Ten tydzień',
            value: `⏱️ **${formatDuration(stats.week)}**\n🏆 Pozycja: **${formatRank(stats.ranks.week)}**`,
            inline: true
          },
          {
            name: '🗓️ Ten miesiąc',
            value: `⏱️ **${formatDuration(stats.month)}**\n🏆 Pozycja: **${formatRank(stats.ranks.month)}**`,
            inline: true
          },
          {
            name: '🏆 Łącznie (od 25.06.2026)',
            value: `⏱️ **${formatDuration(stats.total)}**\n🥇 Pozycja w rankingu: **${formatRank(stats.ranks.total)}**`,
            inline: false
          }
        )
        .setFooter({ text: 'Ekipa Remontowa Bot • Czas liczony od 25.06.2026 • Europe/Warsaw' })
        .setTimestamp();

      if (member?.joinedTimestamp) {
        const joinedUnix = Math.floor(member.joinedTimestamp / 1000);
        embed.addFields({
          name: '🛡️ Informacje o użytkowniku',
          value: `Dołączył(a) na serwer: <t:${joinedUnix}:D> (<t:${joinedUnix}:R>)`,
          inline: false
        });
      }

      return await interaction.editReply({ embeds: [embed] });
    }

    // --- KOMENDA /time ---
    if (commandName === 'time') {
      await interaction.deferReply();

      const targetUser = options.getUser('uzytkownik') || user;
      const period = options.getString('okres') || 'all';
      
      if (period === 'all') {
        const stats = await db.getUserStats(targetUser.id, guildId);
        let liveInfo = '';
        if (stats.activeSession) {
          const joinUnix = Math.floor(stats.activeSession.join_time / 1000);
          const dur = Date.now() - stats.activeSession.join_time;
          liveInfo = `\n🟢 **Aktywny na kanale:** od <t:${joinUnix}:t> (trwa: ${formatDuration(dur)})\n`;
        }

        const embed = new EmbedBuilder()
          .setColor('#43b581')
          .setTitle(`🎙️ Czas na kanałach głosowych — ${targetUser.username}`)
          .setThumbnail(targetUser.displayAvatarURL({ dynamic: true }))
          .setDescription(
            `⏱️ **Łączny czas (od 25.06.2026):** \`${formatDuration(stats.total)}\`${liveInfo}\n` +
            `📅 **Dzisiaj:** ${formatDuration(stats.today)}\n` +
            `📆 **Ten tydzień:** ${formatDuration(stats.week)}\n` +
            `🗓️ **Ten miesiąc:** ${formatDuration(stats.month)}`
          )
          .setFooter({ text: 'Czas liczony od 25.06.2026 • Użyj /profile aby zobaczyć pozycje w rankingu.' })
          .setTimestamp();

        return await interaction.editReply({ embeds: [embed] });
      } else {
        const timeMs = await db.getUserPeriodTime(targetUser.id, guildId, period);
        const rank = await db.getUserRank(targetUser.id, guildId, period);
        const periodLabel = getPeriodLabel(period);
        const activeSession = await db.getActiveSession(targetUser.id, guildId);
        let liveInfo = '';
        if (activeSession) {
          const joinUnix = Math.floor(activeSession.join_time / 1000);
          const dur = Date.now() - activeSession.join_time;
          liveInfo = `\n🟢 **Aktywny na kanale:** od <t:${joinUnix}:t> (trwa: ${formatDuration(dur)})\n`;
        }

        const embed = new EmbedBuilder()
          .setColor('#43b581')
          .setTitle(`🎙️ Czas na kanałach głosowych — ${targetUser.username}`)
          .setThumbnail(targetUser.displayAvatarURL({ dynamic: true }))
          .setDescription(
            `**Okres:** ${periodLabel}\n\n` +
            `⏱️ **Spędzony czas:**\n` +
            '```ansi\n\u001b[1;36m' + formatDuration(timeMs) + '\u001b[0m\n```' +
            (rank ? `🏆 **Pozycja w rankingu:** #${rank}\n` : '') +
            liveInfo
          )
          .setTimestamp();

        return await interaction.editReply({ embeds: [embed] });
      }
    }

    // --- DEDYKOWANA KOMENDA /daily ---
    if (commandName === 'daily') {
      await interaction.deferReply();
      const targetUser = options.getUser('uzytkownik') || user;
      const timeMs = await db.getUserPeriodTime(targetUser.id, guildId, 'today');
      const rank = await db.getUserRank(targetUser.id, guildId, 'today');
      const activeSession = await db.getActiveSession(targetUser.id, guildId);
      let liveInfo = '';
      if (activeSession) {
        const joinUnix = Math.floor(activeSession.join_time / 1000);
        const dur = Date.now() - activeSession.join_time;
        liveInfo = `\n🟢 **Aktywny na kanale:** od <t:${joinUnix}:t> (trwa: ${formatDuration(dur)})\n`;
      }

      const embed = new EmbedBuilder()
        .setColor('#faa61a')
        .setTitle(`📅 Czas dzisiejszy — ${targetUser.username}`)
        .setThumbnail(targetUser.displayAvatarURL({ dynamic: true }))
        .setDescription(
          `Spędzony czas dzisiaj:\n` +
          '```ansi\n\u001b[1;33m' + formatDuration(timeMs) + '\u001b[0m\n```' +
          `🏆 **Pozycja w dzisiejszym rankingu:** ${rank ? `#${rank}` : 'Brak danych'}\n` +
          liveInfo
        )
        .setFooter({ text: 'Ekipa Remontowa Bot • Czas resetuje się codziennie o 00:00' })
        .setTimestamp();

      return await interaction.editReply({ embeds: [embed] });
    }

    // --- DEDYKOWANA KOMENDA /weekly ---
    if (commandName === 'weekly') {
      await interaction.deferReply();
      const targetUser = options.getUser('uzytkownik') || user;
      const timeMs = await db.getUserPeriodTime(targetUser.id, guildId, 'week');
      const rank = await db.getUserRank(targetUser.id, guildId, 'week');
      const activeSession = await db.getActiveSession(targetUser.id, guildId);
      let liveInfo = '';
      if (activeSession) {
        const joinUnix = Math.floor(activeSession.join_time / 1000);
        const dur = Date.now() - activeSession.join_time;
        liveInfo = `\n🟢 **Aktywny na kanale:** od <t:${joinUnix}:t> (trwa: ${formatDuration(dur)})\n`;
      }

      const embed = new EmbedBuilder()
        .setColor('#7289da')
        .setTitle(`📆 Czas tygodniowy — ${targetUser.username}`)
        .setThumbnail(targetUser.displayAvatarURL({ dynamic: true }))
        .setDescription(
          `Spędzony czas w bieżącym tygodniu (od poniedziałku):\n` +
          '```ansi\n\u001b[1;34m' + formatDuration(timeMs) + '\u001b[0m\n```' +
          `🏆 **Pozycja w tygodniowym rankingu:** ${rank ? `#${rank}` : 'Brak danych'}\n` +
          liveInfo
        )
        .setFooter({ text: 'Ekipa Remontowa Bot • Czas resetuje się co poniedziałek o 00:00' })
        .setTimestamp();

      return await interaction.editReply({ embeds: [embed] });
    }

    // --- DEDYKOWANA KOMENDA /monthly ---
    if (commandName === 'monthly') {
      await interaction.deferReply();
      const targetUser = options.getUser('uzytkownik') || user;
      const timeMs = await db.getUserPeriodTime(targetUser.id, guildId, 'month');
      const rank = await db.getUserRank(targetUser.id, guildId, 'month');
      const activeSession = await db.getActiveSession(targetUser.id, guildId);
      let liveInfo = '';
      if (activeSession) {
        const joinUnix = Math.floor(activeSession.join_time / 1000);
        const dur = Date.now() - activeSession.join_time;
        liveInfo = `\n🟢 **Aktywny na kanale:** od <t:${joinUnix}:t> (trwa: ${formatDuration(dur)})\n`;
      }

      const embed = new EmbedBuilder()
        .setColor('#eb459e')
        .setTitle(`🗓️ Czas miesięczny — ${targetUser.username}`)
        .setThumbnail(targetUser.displayAvatarURL({ dynamic: true }))
        .setDescription(
          `Spędzony czas w bieżącym miesiącu:\n` +
          '```ansi\n\u001b[1;35m' + formatDuration(timeMs) + '\u001b[0m\n```' +
          `🏆 **Pozycja w miesięcznym rankingu:** ${rank ? `#${rank}` : 'Brak danych'}\n` +
          liveInfo
        )
        .setFooter({ text: 'Ekipa Remontowa Bot • Czas resetuje się 1. dnia każdego miesiąca' })
        .setTimestamp();

      return await interaction.editReply({ embeds: [embed] });
    }

    // --- KOMENDA /leaderboard ---
    if (commandName === 'leaderboard') {
      await interaction.deferReply();

      const period = options.getString('okres') || 'all';
      const page = options.getInteger('strona') || 1;

      const view = await buildLeaderboardView(guildId, period, page);
      return await interaction.editReply(view);
    }

    // --- POMOCNICZE METODY DO CZYSZENIA WIADOMOŚCI ---
    async function fetchManyMessages(channel, limit) {
      let allMessages = [];
      let lastId = null;
      
      while (allMessages.length < limit) {
        const fetchLimit = Math.min(100, limit - allMessages.length);
        const options = { limit: fetchLimit };
        if (lastId) {
          options.before = lastId;
        }
        
        const fetched = await channel.messages.fetch(options);
        if (fetched.size === 0) break;
        
        allMessages.push(...fetched.values());
        lastId = fetched.last().id;
        
        await new Promise(resolve => setTimeout(resolve, 200));
      }
      
      return allMessages;
    }

    function chunkArray(array, size) {
      const chunks = [];
      for (let i = 0; i < array.length; i += size) {
        chunks.push(array.slice(i, i + size));
      }
      return chunks;
    }

    if (commandName === 'clear') {
      if (!interaction.member.permissions.has(PermissionFlagsBits.ManageMessages)) {
        return await interaction.reply({ 
          content: 'Nie masz uprawnień do zarządzania wiadomościami.', 
          flags: [MessageFlags.Ephemeral]
        });
      }

      if (activeClearChannels.has(interaction.channelId)) {
        return await interaction.reply({
          content: 'Na tym kanale trwa już proces powolnego czyszczenia wiadomości. Użyj komendy `/stop`, aby go przerwać.',
          flags: [MessageFlags.Ephemeral]
        });
      }

      const amount = options.getInteger('ilosc');
      const deleteOld = options.getBoolean('usun_bardzo_stare') !== false;
      const delaySeconds = options.getInteger('opoznienie_sekundy') || 2;
      const olderThanMinutes = options.getInteger('starsze_niz_minuty');
      await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });

      activeClearChannels.add(interaction.channelId);

      try {
        const fetchLimit = Math.max(100, amount);
        await interaction.editReply(`Pobieranie wiadomości z kanału (skanowanie ostatnich ${fetchLimit})...`);
        
        let messages = await fetchManyMessages(interaction.channel, fetchLimit);
        const now = Date.now();

        if (olderThanMinutes !== null && olderThanMinutes !== undefined) {
          const minAgeMs = olderThanMinutes * 60 * 1000;
          messages = messages.filter(msg => (now - msg.createdAt.getTime()) > minAgeMs);
        }

        messages.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

        const messagesToDelete = messages.slice(0, amount);
        const totalMessagesToProcess = messagesToDelete.length;

        if (totalMessagesToProcess === 0) {
          activeClearChannels.delete(interaction.channelId);
          return await interaction.editReply('Nie znaleziono wiadomości spełniających Twoje kryteria do usunięcia na tym kanale.');
        }

        const youngMessages = messagesToDelete.filter(msg => {
          const age = now - msg.createdAt.getTime();
          return age < 14 * 24 * 60 * 60 * 1000 && !msg.pinned;
        });

        let totalDeleted = 0;
        
        if (youngMessages.length > 0) {
          await interaction.editReply(`Znaleziono **${youngMessages.length}** starszych wiadomości (ale młodszych niż 14 dni). Rozpoczynam usuwanie hurtowe...`);
          const youngChunks = chunkArray(youngMessages, 100);
          for (const chunk of youngChunks) {
            if (!activeClearChannels.has(interaction.channelId)) {
              break;
            }
            const deleted = await interaction.channel.bulkDelete(chunk, true);
            totalDeleted += deleted.size;
            await new Promise(resolve => setTimeout(resolve, 1000));
          }
        }

        const oldMessages = messagesToDelete.filter(msg => {
          const age = now - msg.createdAt.getTime();
          const isAlreadyDeleted = youngMessages.some(ym => ym.id === msg.id);
          return age >= 14 * 24 * 60 * 60 * 1000 && !msg.pinned && !isAlreadyDeleted;
        });

        if (deleteOld && oldMessages.length > 0 && activeClearChannels.has(interaction.channelId)) {
          await interaction.editReply(`Pomyślnie usunięto **${totalDeleted}** wiadomości. Rozpoczynam powolne usuwanie **${oldMessages.length}** wiadomości starszych niż 14 dni z opóźnieniem **${delaySeconds} sek.** między każdą z nich...`);
          
          for (const msg of oldMessages) {
            if (!activeClearChannels.has(interaction.channelId)) {
              break;
            }
            try {
              await msg.delete();
              totalDeleted++;
              if (totalDeleted % 5 === 0 || totalDeleted === totalMessagesToProcess) {
                await interaction.editReply(`Trwa usuwanie starych wiadomości... Postęp: **${totalDeleted}** z **${totalMessagesToProcess}** (co ${delaySeconds} sek.).`);
              }
              await new Promise(resolve => setTimeout(resolve, delaySeconds * 1000));
            } catch (err) {
              if (err.code === 10008 || err.message.includes('Unknown Message')) {
                // ignoruj
              } else {
                console.error('Błąd podczas usuwania pojedynczej wiadomości:', err.message);
              }
            }
          }
        }

        if (totalDeleted > 0) {
          await db.incrementDeletedMessages(totalDeleted);
        }
        
        const wasAborted = !activeClearChannels.has(interaction.channelId);

        const embed = new EmbedBuilder()
          .setColor(wasAborted ? '#f04747' : '#43b581')
          .setTitle(wasAborted ? '⚠️ Czyszczenie przerwane' : '🗑️ Usuwanie zakończone')
          .setDescription(wasAborted 
            ? `Proces czyszczenia został zatrzymany przez administratora. Usunięto łącznie **${totalDeleted}** wiadomości.`
            : `Pomyślnie usunięto **${totalDeleted}** z **${totalMessagesToProcess}** przeanalizowanych wiadomości z tego kanału.`)
          .setFooter({ text: 'Statystyki usuniętych wiadomości zostały zaktualizowane.' });

        await interaction.editReply({ content: null, embeds: [embed] });
      } catch (error) {
        console.error('Błąd podczas usuwania wiadomości:', error.message);
        await interaction.editReply({ content: 'Wystąpił błąd podczas usuwania wiadomości. Upewnij się, że bot ma odpowiednie uprawnienia.', embeds: [] });
      } finally {
        activeClearChannels.delete(interaction.channelId);
      }
    }

    if (commandName === 'stop') {
      if (!interaction.member.permissions.has(PermissionFlagsBits.ManageMessages)) {
        return await interaction.reply({ 
          content: 'Nie masz uprawnień do zatrzymywania czyszczenia.', 
          flags: [MessageFlags.Ephemeral]
        });
      }

      if (activeClearChannels.has(interaction.channelId)) {
        activeClearChannels.delete(interaction.channelId);
        return await interaction.reply({ 
          content: '⚙️ Otrzymałem żądanie zatrzymania czyszczenia. Proces zostanie zatrzymany w ciągu kilku sekund.', 
          flags: [MessageFlags.Ephemeral]
        });
      } else {
        return await interaction.reply({ 
          content: 'Na tym kanale nie trwa obecnie żadne powolne usuwanie wiadomości.', 
          flags: [MessageFlags.Ephemeral]
        });
      }
    }

    if (commandName === 'autoclean') {
      if (!interaction.member.permissions.has(PermissionFlagsBits.ManageMessages)) {
        return await interaction.reply({ 
          content: 'Nie masz uprawnień do zmiany statusu automatycznego czyszczenia.', 
          flags: [MessageFlags.Ephemeral]
        });
      }

      const status = options.getBoolean('status');
      isAutoCleanEnabled = status;

      const embed = new EmbedBuilder()
        .setColor(status ? '#43b581' : '#f04747')
        .setTitle('⚙️ Automatyczne czyszczenie kanału')
        .setDescription(`Automatyczne czyszczenie kanału zostało **${status ? 'WŁĄCZONE' : 'WYŁĄCZONE'}**.`);

      return await interaction.reply({ embeds: [embed] });
    }
  } catch (error) {
    console.error('❌ Nieoczekiwany błąd podczas obsługi interakcji:', error);
    const errorMsg = '⚠️ Wystąpił błąd podczas wykonywania tej komendy. Spróbuj ponownie.';
    if (interaction.isRepliable()) {
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply({ content: errorMsg, embeds: [], components: [] }).catch(() => null);
      } else {
        await interaction.reply({ content: errorMsg, flags: [MessageFlags.Ephemeral] }).catch(() => null);
      }
    }
  }
});

// Reakcja na nowe wiadomości w celu natychmiastowego zaplanowania/czyszczenia kanału
client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  const cleanChannelId = process.env.CLEAN_CHANNEL_ID;
  if (message.channelId === cleanChannelId) {
    const lifetimeMinutes = parseInt(process.env.MESSAGE_LIFETIME_MINUTES || '60', 10);
    cleanChannel(cleanChannelId, lifetimeMinutes);
  }
});

// --- AUTOMATYCZNE USUWANIE WIADOMOŚCI ---
let autoCleanTimeout = null;
let isCleanChannelRunning = false;
let shouldReRunClean = false;

function startAutoCleanLoop() {
  const cleanChannelId = process.env.CLEAN_CHANNEL_ID;
  const lifetimeMinutes = parseInt(process.env.MESSAGE_LIFETIME_MINUTES || '60', 10);

  if (!cleanChannelId || cleanChannelId === 'twoje_channel_id_tutaj') {
    console.log('[AutoClean] Automatyczne usuwanie wiadomości nie zostało skonfigurowane (brak poprawnego CLEAN_CHANNEL_ID).');
    return;
  }

  console.log(`[AutoClean] Uruchomiono inteligentne czyszczenie kanału ${cleanChannelId}. Czas życia wiadomości: ${lifetimeMinutes} min.`);

  setTimeout(() => cleanChannel(cleanChannelId, lifetimeMinutes), 10000);

  setInterval(() => {
    cleanChannel(cleanChannelId, lifetimeMinutes);
  }, 15 * 60 * 1000);
}

async function cleanChannel(channelId, lifetimeMinutes) {
  if (isCleanChannelRunning) {
    shouldReRunClean = true;
    return;
  }
  isCleanChannelRunning = true;

  try {
    if (!isAutoCleanEnabled) {
      return;
    }

    const channel = await client.channels.fetch(channelId);
    if (!channel || !channel.isTextBased()) {
      return;
    }

    const messages = await channel.messages.fetch({ limit: 100 });
    const now = Date.now();
    const lifetimeMs = lifetimeMinutes * 60 * 1000;
    const keepCount = parseInt(process.env.KEEP_NEWEST_COUNT || '3', 10);
    const delaySeconds = parseInt(process.env.AUTOCLEAN_DELAY_SECONDS || '2', 10);

    const sortedMessages = [...messages.values()].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    const candidateMessages = sortedMessages.slice(keepCount);

    const toDeleteNow = [];
    const toDeleteLater = [];

    for (const msg of candidateMessages) {
      if (msg.pinned) continue;
      const age = now - msg.createdAt.getTime();
      if (age >= lifetimeMs) {
        toDeleteNow.push(msg);
      } else {
        toDeleteLater.push(msg);
      }
    }

    // 1. USUWANIE WIADOMOŚCI PRZETERMINOWANYCH
    if (toDeleteNow.length > 0) {
      console.log(`[AutoClean] Znaleziono ${toDeleteNow.length} wiadomości do usunięcia. Uruchamiam powolne usuwanie (co ${delaySeconds} sek.)...`);
      let deletedCount = 0;
      for (const msg of toDeleteNow) {
        if (!isAutoCleanEnabled) break;
        try {
          await msg.delete();
          deletedCount++;
          await new Promise(resolve => setTimeout(resolve, delaySeconds * 1000));
        } catch (err) {
          if (err.code === 10008 || err.message.includes('Unknown Message')) {
            // Ignorujemy cicho
          } else {
            console.error('[AutoClean] Błąd podczas usuwania pojedynczej wiadomości:', err.message);
          }
        }
      }
      if (deletedCount > 0) {
        console.log(`[AutoClean] Pomyślnie usunięto powoli ${deletedCount} wiadomości.`);
        await db.incrementDeletedMessages(deletedCount);
      }
    }

    // 2. DYNAMICZNE PLANOWANIE KOLEJNEGO URUCHOMIENIA
    if (autoCleanTimeout) {
      clearTimeout(autoCleanTimeout);
      autoCleanTimeout = null;
    }

    if (toDeleteLater.length > 0) {
      toDeleteLater.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
      const oldestMsg = toDeleteLater[0];
      const age = now - oldestMsg.createdAt.getTime();
      const remainingMs = lifetimeMs - age;

      const nextRunMs = Math.max(1000, remainingMs + 1500);
      autoCleanTimeout = setTimeout(() => cleanChannel(channelId, lifetimeMinutes), nextRunMs);
    }
  } catch (error) {
    console.error('[AutoClean] Błąd podczas czyszczenia wiadomości:', error.message);
  } finally {
    isCleanChannelRunning = false;
    if (shouldReRunClean) {
      shouldReRunClean = false;
      setTimeout(() => cleanChannel(channelId, lifetimeMinutes), 1000);
    }
  }
}

// Zaloguj bota
const token = process.env.DISCORD_TOKEN;
if (token && token !== 'twoj_token_bota_tutaj') {
  console.log('🔄 Rozpoczynam logowanie do Discord Gateway (Token jest obecny)...');
  client.login(token)
    .then(() => {
      console.log('✅ Połączenie z bramą Discord nawiązane pomyślnie.');
    })
    .catch((err) => {
      console.error('❌ KRYTYCZNY BŁĄD PODCZAS LOGOWANIA DO DISCORDA:', err);
    });
} else {
  console.error('❌ BŁĄD: Brak podanego tokenu bota (DISCORD_TOKEN) w zmiennych środowiskowych! Bot nie został zalogowany.');
}
