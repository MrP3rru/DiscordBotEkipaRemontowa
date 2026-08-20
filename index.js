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
  MessageFlags
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
  res.send({ status: 'ok', message: 'Bot Ekipa Remontowa jest aktywny!' });
});

app.get('/healthz', (req, res) => {
  res.status(200).send('OK');
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
      text: `Strona ${actualPage} z ${totalPages} • Osób w rankingu: ${totalCount} • Ekipa Remontowa Bot` 
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

  // Uruchomienie pętli automatycznego usuwania wiadomości
  startAutoCleanLoop();
});

// --- REJESTROWANIE CZASU NA KANAŁACH GŁOSOWYCH ---
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
  } catch (err) {
    console.error('Błąd w zdarzeniu voiceStateUpdate:', err.message);
  }
});

// --- OBSŁUGA INTERAKCJI (KOMEND SLASH I PRZYCISKÓW) ---
client.on('interactionCreate', async (interaction) => {
  try {
    // 1. OBSŁUGA PRZYCISKÓW PAGINACJI LEADERBOARD
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
        voiceStatus = `🟢 **Status:** Na kanale ${channelMention} (od <t:${joinUnix}:R>)`;
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
            name: '🏆 Łącznie (All-time)',
            value: `⏱️ **${formatDuration(stats.total)}**\n🥇 Pozycja w rankingu: **${formatRank(stats.ranks.total)}**`,
            inline: false
          }
        )
        .setFooter({ text: 'Ekipa Remontowa Bot • Strefa czasowa: Europe/Warsaw' })
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
        const embed = new EmbedBuilder()
          .setColor('#43b581')
          .setTitle(`🎙️ Czas na kanałach głosowych — ${targetUser.username}`)
          .setThumbnail(targetUser.displayAvatarURL({ dynamic: true }))
          .setDescription(
            `⏱️ **Łączny czas:** \`${formatDuration(stats.total)}\`\n\n` +
            `📅 **Dzisiaj:** ${formatDuration(stats.today)}\n` +
            `📆 **Ten tydzień:** ${formatDuration(stats.week)}\n` +
            `🗓️ **Ten miesiąc:** ${formatDuration(stats.month)}`
          )
          .setFooter({ text: 'Użyj /profile aby zobaczyć pozycję w rankingu.' })
          .setTimestamp();

        return await interaction.editReply({ embeds: [embed] });
      } else {
        const timeMs = await db.getUserPeriodTime(targetUser.id, guildId, period);
        const rank = await db.getUserRank(targetUser.id, guildId, period);
        const periodLabel = getPeriodLabel(period);

        const embed = new EmbedBuilder()
          .setColor('#43b581')
          .setTitle(`🎙️ Czas na kanałach głosowych — ${targetUser.username}`)
          .setThumbnail(targetUser.displayAvatarURL({ dynamic: true }))
          .setDescription(
            `**Okres:** ${periodLabel}\n\n` +
            `⏱️ **Spędzony czas:**\n` +
            '```ansi\n\u001b[1;36m' + formatDuration(timeMs) + '\u001b[0m\n```' +
            (rank ? `🏆 **Pozycja w rankingu:** #${rank}` : '')
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

      const embed = new EmbedBuilder()
        .setColor('#faa61a')
        .setTitle(`📅 Czas dzisiejszy — ${targetUser.username}`)
        .setThumbnail(targetUser.displayAvatarURL({ dynamic: true }))
        .setDescription(
          `Spędzony czas dzisiaj:\n` +
          '```ansi\n\u001b[1;33m' + formatDuration(timeMs) + '\u001b[0m\n```' +
          `🏆 **Pozycja w dzisiejszym rankingu:** ${rank ? `#${rank}` : 'Brak danych'}`
        )
        .setFooter({ text: 'Ekipa Remontowa Bot' })
        .setTimestamp();

      return await interaction.editReply({ embeds: [embed] });
    }

    // --- DEDYKOWANA KOMENDA /weekly ---
    if (commandName === 'weekly') {
      await interaction.deferReply();
      const targetUser = options.getUser('uzytkownik') || user;
      const timeMs = await db.getUserPeriodTime(targetUser.id, guildId, 'week');
      const rank = await db.getUserRank(targetUser.id, guildId, 'week');

      const embed = new EmbedBuilder()
        .setColor('#7289da')
        .setTitle(`📆 Czas tygodniowy — ${targetUser.username}`)
        .setThumbnail(targetUser.displayAvatarURL({ dynamic: true }))
        .setDescription(
          `Spędzony czas w bieżącym tygodniu (od poniedziałku):\n` +
          '```ansi\n\u001b[1;34m' + formatDuration(timeMs) + '\u001b[0m\n```' +
          `🏆 **Pozycja w tygodniowym rankingu:** ${rank ? `#${rank}` : 'Brak danych'}`
        )
        .setFooter({ text: 'Ekipa Remontowa Bot' })
        .setTimestamp();

      return await interaction.editReply({ embeds: [embed] });
    }

    // --- DEDYKOWANA KOMENDA /monthly ---
    if (commandName === 'monthly') {
      await interaction.deferReply();
      const targetUser = options.getUser('uzytkownik') || user;
      const timeMs = await db.getUserPeriodTime(targetUser.id, guildId, 'month');
      const rank = await db.getUserRank(targetUser.id, guildId, 'month');

      const embed = new EmbedBuilder()
        .setColor('#eb459e')
        .setTitle(`🗓️ Czas miesięczny — ${targetUser.username}`)
        .setThumbnail(targetUser.displayAvatarURL({ dynamic: true }))
        .setDescription(
          `Spędzony czas w bieżącym miesiącu:\n` +
          '```ansi\n\u001b[1;35m' + formatDuration(timeMs) + '\u001b[0m\n```' +
          `🏆 **Pozycja w miesięcznym rankingu:** ${rank ? `#${rank}` : 'Brak danych'}`
        )
        .setFooter({ text: 'Ekipa Remontowa Bot' })
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
