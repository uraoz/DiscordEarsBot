import { SlashCommandBuilder } from "discord.js";

export const commands = [
    new SlashCommandBuilder()
        .setName("join")
        .setDescription("ボイスチャンネルに参加して文字起こしを開始します"),
    new SlashCommandBuilder()
        .setName("leave")
        .setDescription("ボイスチャンネルから退出します"),
    new SlashCommandBuilder()
        .setName("status")
        .setDescription("STTサーバーの状態を確認します"),
];
