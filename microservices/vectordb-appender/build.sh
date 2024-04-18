#!/bin/bash
# Build Docker image

docker build -t vectordb-appender \
    --platform linux/amd64 \
    -f ./src/Dockerfile \
    ./src