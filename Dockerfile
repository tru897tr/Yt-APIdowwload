FROM node:20-slim

# Cài Python + pip để chạy yt-dlp, và ffmpeg để mux video+audio
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        python3 \
        python3-pip \
        ffmpeg \
        ca-certificates \
        curl && \
    rm -rf /var/lib/apt/lists/*

# Cài yt-dlp bản mới nhất qua pip (khuyến nghị hơn apt vì update nhanh hơn)
RUN pip3 install --no-cache-dir --break-system-packages -U yt-dlp

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY src ./src

# Thư mục lưu file tải tạm - sẽ tự dọn theo TTL trong code
RUN mkdir -p /app/downloads

ENV NODE_ENV=production
ENV DOWNLOAD_DIR=/app/downloads
ENV PORT=10000

EXPOSE 10000

CMD ["node", "src/server.js"]
