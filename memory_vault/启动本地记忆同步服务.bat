@echo off
chcp 65001 >nul
title 抖音火花助手 - 本地记忆库(Obsidian/MD)同步服务
cd /d "%~dp0"
echo 正在启动本地记忆库同步服务 (端口 18991)...
node vault_bridge.js
pause
