#!/usr/bin/env bash
cd "$(dirname "$0")"
echo "Installing dependencies (first run only)..."
npm install
echo "Starting YT → FiveManage..."
npm start
