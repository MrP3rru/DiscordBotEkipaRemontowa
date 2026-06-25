require('dotenv').config();
const express = require('express');
const { 
  Client, 
  GatewayIntentBits, 
  ActivityType, 
  EmbedBuilder, 
  PermissionFlagsBits, 
  ApplicationCommandOptionType,
  MessageFlags
} = require('discord.js');
const db = require('./database');

// --- GLOBALNE ZMIENNE STANU BOTA ---
const activeClearChannels = new Set();
let isAutoCleanEnabled = true;

// --- SERWER EXPRESS (Utrzymanie aktywności na Render) ---
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
  res.send({ status: 'ok', message: 'Bot Ekipa Remontowa jest aktywny!' });
});

app.get('/healthz', (req, res) => {
  res.status(200).send('OK');
});

app.listen(PORT, () => {
  console.log(`Serwer HTTP nasłuchuje na porcie ${PORT}`);
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
  const hours = Math.floor(ms / (1000 * 60 * 60));
  const minutes = Math.floor((ms / (1000 * 60)) % 60);
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  return `${minutes}m`;
}

// Funkcja aktualizująca status bota (Usunięte wiadomości) w czasie rzeczywistym
async function updatePresence() {
  try {
    const guildId = process.env.GUILD_ID;
    if (!guildId || guildId === 'twoje_guild_id_tutaj') {
      client.user.setActivity('brak konfiguracji GUILD_ID 🎙️', { type: ActivityType.Listening });
      return;
    }

    // Pobierz łączną liczbę usuniętych wiadomości i sformatuj (np. 1.2k)
    const deletedCount = await db.getDeletedMessagesCount();
    const formattedDeleted = formatNumberShort(deletedCount);
    const statusText = `🗑️ Usunięto: ${formattedDeleted}`;

    // Ustawienie statusu bota (Custom Status)
    client.user.setPresence({
      activities: [{ 
        name: statusText,
        type: ActivityType.Custom,
        state: statusText
      }],
      status: 'online',
    });

    // Alternatywnie ustawiamy aktywność jako fallback
    client.user.setActivity(statusText, { type: ActivityType.Custom });
  } catch (error) {
    console.error('Błąd podczas aktualizowania obecności bota:', error);
  }
}

// Funkcja aktualizująca opis aplikacji "O mnie" (Topka 3)
async function updateApplicationBio() {
  try {
    const guildId = process.env.GUILD_ID;
    if (!guildId || guildId === 'twoje_guild_id_tutaj') return;

    // Pobierz ranking 3 najlepszych użytkowników czasu głosowego
    const leaderboard = await db.getLeaderboard(guildId, 3);
    
    // Budujemy tekst opisu aplikacji (O mnie)
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
    
    // Aktualizujemy opis aplikacji (O mnie) bota
    if (client.application) {
      await client.application.edit({ description: bioText });
    }
  } catch (error) {
    console.error('Błąd podczas aktualizowania opisu bota (O mnie):', error.message);
  }
}

// Obsługa uruchomienia bota
client.once('ready', async () => {
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
    } catch (err) {
      console.error('[Diagnostyka] Błąd pobierania danych o serwerze:', err.message);
    }
  }

  // Uruchomienie pętli aktualizujących (status co 15 sekund, "O mnie" co 30 sekund)
  updatePresence();
  updateApplicationBio();
  setInterval(updatePresence, 15000); // co 15 sekund
  setInterval(updateApplicationBio, 30000); // co 30 sekund

  // Definicja komend Slash
  const commands = [
    {
      name: 'time',
      description: 'Pokazuje łączny czas spędzony na kanałach głosowych.',
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
      description: 'Pokazuje ranking użytkowników z największą ilością czasu na kanałach głosowych.'
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
      // Rejestracja natychmiastowa na konkretnym serwerze (dla celów testowych/szybkiego startu)
      const guild = await client.guilds.fetch(guildId);
      await guild.commands.set(commands);
      console.log(`Zarejestrowano komendy Slash lokalnie dla serwera: ${guild.name}`);
    } else {
      // Rejestracja globalna (może zająć do godziny w Discordzie, ale jest zalecana na produkcji)
      await client.application.commands.set(commands);
      console.log('Zarejestrowano komendy Slash globalnie.');
    }
  } catch (error) {
    console.error('Błąd podczas rejestracji komend Slash:', error);
  }

  // Uruchomienie pętli automatycznego usuwania wiadomości
  startAutoCleanLoop();
});

// --- REJESTROWANIE CZASU NA KANAŁACH GŁOSOWYCH ---
client.on('voiceStateUpdate', async (oldState, newState) => {
  const member = newState.member || oldState.member;
  if (!member || member.user.bot) return; // Ignorujemy boty

  // Log debugowania - zakomentowany ze względu na spam w konsoli
  // console.log(`[DEBUG Voice] Wykryto aktywność użytkownika ${member.user.tag}. Kanał Stary: ${oldState.channelId || 'Brak'}, Kanał Nowy: ${newState.channelId || 'Brak'}`);

  const userId = member.id;
  const guildId = newState.guild?.id || oldState.guild?.id;

  const joinedChannel = !oldState.channelId && newState.channelId;
  const leftChannel = oldState.channelId && !newState.channelId;
  const switchedChannel = oldState.channelId && newState.channelId && oldState.channelId !== newState.channelId;

  if (joinedChannel) {
    // Użytkownik wszedł na kanał głosowy
    await db.startVoiceSession(userId, guildId);
    console.log(`[Voice] ${member.user.tag} dołączył do kanału głosowego.`);
  } else if (leftChannel) {
    // Użytkownik wyszedł z kanału głosowego
    await db.endVoiceSession(userId, guildId);
    console.log(`[Voice] ${member.user.tag} opuścił kanał głosowy.`);
  } else if (switchedChannel) {
    // Użytkownik zmienił kanał
    await db.endVoiceSession(userId, guildId);
    await db.startVoiceSession(userId, guildId);
    console.log(`[Voice] ${member.user.tag} zmienił kanał głosowy.`);
  }
});

// --- OBSŁUGA INTERAKCJI (KOMEND SLASH) ---
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const { commandName, options, guildId, user } = interaction;

  if (commandName === 'time') {
    await interaction.deferReply();

    const targetUser = options.getUser('uzytkownik') || user;
    const timeMs = await db.getUserTime(targetUser.id, guildId);

    const embed = new EmbedBuilder()
      .setColor('#43b581')
      .setTitle(`🎙️ Czas na kanałach głosowych`)
      .setDescription(`Użytkownik **${targetUser.username}** spędził łącznie:\n` + '```ansi\n\u001b[1;36m' + formatDuration(timeMs) + '\u001b[0m\n```')
      .setThumbnail(targetUser.displayAvatarURL({ dynamic: true }))
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
  }

  if (commandName === 'leaderboard') {
    await interaction.deferReply();

    const leaderboard = await db.getLeaderboard(guildId, 10);
    if (leaderboard.length === 0) {
      return interaction.editReply('Brak danych o aktywności głosowej na tym serwerze.');
    }

    let description = '';
    for (let i = 0; i < leaderboard.length; i++) {
      const row = leaderboard[i];
      let userTag = `<@${row.user_id}>`;
      
      // Dodatkowe formatowanie dla top 3
      let medal = '';
      if (i === 0) medal = '🥇 ';
      else if (i === 1) medal = '🥈 ';
      else if (i === 2) medal = '🥉 ';
      else medal = `${i + 1}. `;

      description += `${medal}${userTag}: **${formatDuration(row.total_time)}**\n`;
    }

    const embed = new EmbedBuilder()
      .setColor('#5865F2')
      .setTitle('🏆 Ranking aktywności na kanałach głosowych')
      .setDescription(description)
      .setTimestamp()
      .setFooter({ text: 'Ekipa Remontowa Bot' });

    await interaction.editReply({ embeds: [embed] });
  }

  // --- POMOCNICZE METODY DO CZYSZENIA WIADOMOŚCI ---
  // Pobieranie wielu wiadomości w pętli (ponieważ pojedyncze zapytanie ma limit 100)
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
      
      // Małe opóźnienie, aby nie przeciążyć API
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    
    return allMessages;
  }

  // Dzielenie tablicy na mniejsze kawałki
  function chunkArray(array, size) {
    const chunks = [];
    for (let i = 0; i < array.length; i += size) {
      chunks.push(array.slice(i, i + size));
    }
    return chunks;
  }

  if (commandName === 'clear') {
    // Sprawdzenie uprawnień (chociaż Discord.js v14 i tak filtruje to na poziomie interfejsu)
    if (!interaction.member.permissions.has(PermissionFlagsBits.ManageMessages)) {
      return interaction.reply({ 
        content: 'Nie masz uprawnień do zarządzania wiadomościami.', 
        flags: [MessageFlags.Ephemeral]
      });
    }

    if (activeClearChannels.has(interaction.channelId)) {
      return interaction.reply({
        content: 'Na tym kanale trwa już proces powolnego czyszczenia wiadomości. Użyj komendy `/stop`, aby go przerwać.',
        flags: [MessageFlags.Ephemeral]
      });
    }

    const amount = options.getInteger('ilosc');
    const deleteOld = options.getBoolean('usun_bardzo_stare') !== false; // Domyślnie: true (Tak)
    const delaySeconds = options.getInteger('opoznienie_sekundy') || 2; // Domyślnie 2 sekundy
    const olderThanMinutes = options.getInteger('starsze_niz_minuty');
    await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });

    // Oznaczamy kanał jako aktywny w procesie czyszczenia
    activeClearChannels.add(interaction.channelId);

    try {
      // Pobieramy nieco większą pulę wiadomości, aby móc wybrać najstarsze spełniające kryteria
      const fetchLimit = Math.max(100, amount);
      await interaction.editReply(`Pobieranie wiadomości z kanału (skanowanie ostatnich ${fetchLimit})...`);
      
      let messages = await fetchManyMessages(interaction.channel, fetchLimit);
      const now = Date.now();

      // Filtrowanie wiadomości według starsze_niz_minuty, jeśli podano
      if (olderThanMinutes !== null && olderThanMinutes !== undefined) {
        const minAgeMs = olderThanMinutes * 60 * 1000;
        messages = messages.filter(msg => (now - msg.createdAt.getTime()) > minAgeMs);
      }

      // Sortujemy wiadomości od najstarszych do najnowszych (najstarsze najpierw)
      messages.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

      // Wybieramy dokładnie tyle najstarszych wiadomości, ile zażądał użytkownik
      const messagesToDelete = messages.slice(0, amount);
      const totalMessagesToProcess = messagesToDelete.length;

      if (totalMessagesToProcess === 0) {
        activeClearChannels.delete(interaction.channelId);
        return interaction.editReply('Nie znaleziono wiadomości spełniających Twoje kryteria do usunięcia na tym kanale.');
      }

      // Filtrujemy wiadomości młodsze niż 14 dni do szybkiego usunięcia
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

      // Filtrujemy wiadomości starsze niż 14 dni
      const oldMessages = messagesToDelete.filter(msg => {
        const age = now - msg.createdAt.getTime();
        const isAlreadyDeleted = youngMessages.some(ym => ym.id === msg.id);
        return age >= 14 * 24 * 60 * 60 * 1000 && !msg.pinned && !isAlreadyDeleted;
      });

      if (deleteOld && oldMessages.length > 0 && activeClearChannels.has(interaction.channelId)) {
        await interaction.editReply(`Pomyślnie usunięto **${totalDeleted}** wiadomości. Rozpoczynam powolne usuwanie **${oldMessages.length}** wiadomości starszych niż 14 dni z opóźnieniem **${delaySeconds} sek.** między każdą z nich...`);
        
        for (const msg of oldMessages) {
          // Sprawdzamy czy nie zatrzymano procesu
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
              console.log(`[/clear] Wiadomość o ID ${msg.id} była już wcześniej usunięta przez kogoś innego.`);
            } else {
              console.error('Błąd podczas usuwania pojedynczej wiadomości:', err);
            }
          }
        }
      }

      // Zapisujemy usunięte wiadomości w statystykach bazy danych
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
      console.error('Błąd podczas usuwania wiadomości:', error);
      await interaction.editReply({ content: 'Wystąpił błąd podczas usuwania wiadomości. Upewnij się, że bot ma odpowiednie uprawnienia.', embeds: [] });
    } finally {
      // Usuwamy kanał z aktywnych
      activeClearChannels.delete(interaction.channelId);
    }
  }

  if (commandName === 'stop') {
    if (!interaction.member.permissions.has(PermissionFlagsBits.ManageMessages)) {
      return interaction.reply({ 
        content: 'Nie masz uprawnień do zatrzymywania czyszczenia.', 
        flags: [MessageFlags.Ephemeral]
      });
    }

    if (activeClearChannels.has(interaction.channelId)) {
      activeClearChannels.delete(interaction.channelId);
      return interaction.reply({ 
        content: '⚙️ Otrzymałem żądanie zatrzymania czyszczenia. Proces zostanie zatrzymany w ciągu kilku sekund.', 
        flags: [MessageFlags.Ephemeral]
      });
    } else {
      return interaction.reply({ 
        content: 'Na tym kanale nie trwa obecnie żadne powolne usuwanie wiadomości.', 
        flags: [MessageFlags.Ephemeral]
      });
    }
  }

  if (commandName === 'autoclean') {
    if (!interaction.member.permissions.has(PermissionFlagsBits.ManageMessages)) {
      return interaction.reply({ 
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

    return interaction.reply({ embeds: [embed] });
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

  // Pierwsze sprawdzenie przy starcie bota (z opóźnieniem 10s, aby bot zdążył się w pełni połączyć)
  setTimeout(() => cleanChannel(cleanChannelId, lifetimeMinutes), 10000);

  // Zapasowe sprawdzanie co 15 minut (jako fallback zabezpieczający)
  setInterval(() => {
    cleanChannel(cleanChannelId, lifetimeMinutes);
  }, 15 * 60 * 1000);
}

async function cleanChannel(channelId, lifetimeMinutes) {
  if (isCleanChannelRunning) {
    // Jeśli proces już trwa, ustawiamy flagę ponownego wykonania po jego zakończeniu
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

    // Pobierz ostatnie 100 wiadomości
    const messages = await channel.messages.fetch({ limit: 100 });
    const now = Date.now();
    const lifetimeMs = lifetimeMinutes * 60 * 1000;
    const keepCount = parseInt(process.env.KEEP_NEWEST_COUNT || '3', 10);
    const delaySeconds = parseInt(process.env.AUTOCLEAN_DELAY_SECONDS || '2', 10);

    // Sortujemy pobrane wiadomości od najnowszych do najstarszych (najnowsze na początku)
    const sortedMessages = [...messages.values()].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

    // Pomijamy pierwsze keepCount najnowszych wiadomości
    const candidateMessages = sortedMessages.slice(keepCount);

    // Dzielimy wiadomości na te do usunięcia natychmiast oraz te do zaplanowania na później
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
          // Opóźnienie między usunięciem kolejnej wiadomości
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
      // Sortujemy od najstarszych do najnowszych (najstarsza z nich wygaśnie jako pierwsza)
      toDeleteLater.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
      const oldestMsg = toDeleteLater[0];
      const age = now - oldestMsg.createdAt.getTime();
      const remainingMs = lifetimeMs - age;

      // Planujemy kolejne sprawdzenie dokładnie na moment wygaśnięcia tej wiadomości (+ zapas 1.5 sekundy)
      const nextRunMs = Math.max(1000, remainingMs + 1500);
      autoCleanTimeout = setTimeout(() => cleanChannel(channelId, lifetimeMinutes), nextRunMs);
    }
  } catch (error) {
    console.error('[AutoClean] Błąd podczas czyszczenia wiadomości:', error);
  } finally {
    isCleanChannelRunning = false;
    if (shouldReRunClean) {
      shouldReRunClean = false;
      // Jeśli w międzyczasie pojawiły się nowe wiadomości, uruchom ponownie sprawdzanie za sekundę
      setTimeout(() => cleanChannel(channelId, lifetimeMinutes), 1000);
    }
  }
}

// Zaloguj bota
const token = process.env.DISCORD_TOKEN;
if (token && token !== 'twoj_token_bota_tutaj') {
  client.login(token);
} else {
  console.error('BŁĄD: Brak podanego tokenu bota w pliku .env! Bot nie został zalogowany.');
}
