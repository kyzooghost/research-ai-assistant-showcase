#!/bin/bash
# Build Docker image

docker build -t context-window-lambda \
    --platform linux/amd64 \
    -f ./src/Dockerfile \
    ./src