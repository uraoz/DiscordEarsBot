import { Client, GatewayIntentBits, Events, REST, Routes } from "discord.js";
import { config } from "./config";
import { commands } from "./commands";
import { VoiceHandler } from "./voice-handler";

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildMembers, // ユーザー名取得に必要
    ],
});

// Guild ごとの VoiceHandler を管理
const handlers: Map<string, VoiceHandler> = new Map();

client.once(Events.ClientReady, async (c) => {
    console.log(`Logged in as ${c.user.tag}`);

    // スラッシュコマンド登録
    try {
        const rest = new REST({ version: "10" }).setToken(config.discord.token);
        await rest.put(Routes.applicationCommands(config.discord.clientId), {
            body: commands.map((c) => c.toJSON()),
        });
        console.log("Slash commands registered");
    } catch (e) {
        console.error("Failed to register slash commands:", e);
    }
});

client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    if (!interaction.guildId) return;

    const { commandName } = interaction;

    if (commandName === "join") {
        const member = interaction.member;
        // GuildMember の voice.channel を取得
        const voiceChannel = (member as any)?.voice?.channel;
        if (!voiceChannel) {
            await interaction.reply({
                content: "⚠️ 先にボイスチャンネルに参加してください。",
                ephemeral: true,
            });
            return;
        }

        // 既存ハンドラがあれば切断
        const existing = handlers.get(interaction.guildId);
        if (existing) existing.disconnect();

        const handler = new VoiceHandler(
            client,
            interaction.channel!,
            interaction.guildId
        );
        handlers.set(interaction.guildId, handler);

        await interaction.deferReply();
        try {
            await handler.join(voiceChannel);
            await interaction.editReply(
                `🎙️ **${voiceChannel.name}** で文字起こしを開始しました。`
            );
        } catch (e) {
            await interaction.editReply("❌ 接続に失敗しました。STTサーバーが起動しているか確認してください。");
            handlers.delete(interaction.guildId);
            console.error(e);
        }
    }

    if (commandName === "leave") {
        const handler = handlers.get(interaction.guildId);
        if (handler) {
            handler.disconnect();
            handlers.delete(interaction.guildId);
            await interaction.reply("👋 切断しました。");
        } else {
            await interaction.reply({
                content: "現在接続していません。",
                ephemeral: true,
            });
        }
    }

    if (commandName === "status") {
        try {
            const res = await fetch(`http://127.0.0.1:8765/health`);
            const data = (await res.json()) as {
                status: string;
                active_connections: number;
            };
            await interaction.reply(
                `📊 STTサーバー: **${data.status}** / アクティブ接続: **${data.active_connections}**`
            );
        } catch {
            await interaction.reply("❌ STTサーバーに接続できません。");
        }
    }
});

// ユーザーがVCから退出したときのクリーンアップ
client.on(Events.VoiceStateUpdate, (oldState, newState) => {
    // ボット自身の状態変化は無視
    if (oldState.member?.user.bot) return;

    // VCから退出した場合（oldState.channelId があって newState.channelId がない）
    if (oldState.channelId && !newState.channelId) {
        // ハンドラがあれば、そのユーザーのリスニングを停止
        // （VoiceHandler 内の receiver.subscribe が自動的に end を発火する）
        console.log(
            `User ${oldState.member?.user.tag} left voice channel`
        );
    }
});

client.login(config.discord.token);
