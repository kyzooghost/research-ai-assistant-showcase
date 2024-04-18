#!/bin/bash
# Build Docker image

docker build -t reset-db-lambda \
    --platform linux/amd64 \
    -f ./src/Dockerfile \
    ./src