#!/bin/bash
# Build Docker image

docker build -t user-query-lambda \
    --platform linux/amd64 \
    -f ./src/Dockerfile \
    ./src