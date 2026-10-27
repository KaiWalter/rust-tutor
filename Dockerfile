# rust-tutor — rustc + rustfmt (no cargo) + Node 22 server + bundled Monaco
FROM node:22-bookworm-slim AS web
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

FROM node:22-bookworm-slim AS node

FROM rust:1-slim-bookworm AS runtime
# Pin the toolchain binaries directly (no rustup proxy, no cargo on PATH).
RUN rustup component add rustfmt \
    && sysroot="$(rustc --print sysroot)" \
    && ln -s "$sysroot/bin/rustc" /usr/local/bin/rustc \
    && ln -s "$sysroot/bin/rustfmt" /usr/local/bin/rustfmt \
    && rm -f "$sysroot/bin/cargo" "$sysroot/bin/rust-gdb" "$sysroot/bin/rust-gdbgui" "$sysroot/bin/rust-lldb" \
    && rm -rf /usr/local/cargo/bin \
    && rm -rf "$sysroot/share/doc" "$sysroot/share/man" \
    && chmod -R a+rX /usr/local/rustup
COPY --from=node /usr/local/bin/node /usr/local/bin/node
# uid 1000 matches the host owner of the LAN TLS key and the data dir.
RUN groupadd -g 990 tutor && useradd -u 1000 -g 990 -M -d /tmp -s /usr/sbin/nologin tutor \
    && mkdir -p /data && chown 1000:990 /data
WORKDIR /app
ENV PATH=/usr/local/bin:/usr/bin:/bin \
    RUSTUP_HOME=/usr/local/rustup \
    NODE_ENV=production \
    PORT=5020 \
    BIND_HOST=:: \
    DATA_DIR=/data \
    TMPDIR=/tmp \
    LESSONS_DIR=/app/lessons \
    PROMPTS_DIR=/app/prompts \
    STATIC_DIR=/app/web \
    ALLOWLIST_CONFIG=/app/allowlist.json \
    RUNNER_URL=http://127.0.0.1:4930 \
    TLS_CERT=/certs/server.crt \
    TLS_KEY=/certs/server.key
COPY --from=web /src/node_modules/monaco-editor/min/vs ./web/vendor/monaco/vs
COPY package.json allowlist.json ./
COPY server ./server
COPY lessons ./lessons
COPY prompts ./prompts
COPY web ./web
COPY tests ./tests
COPY scripts ./scripts
USER 1000:990
VOLUME ["/data"]
EXPOSE 5020
HEALTHCHECK --interval=30s --timeout=4s --start-period=10s --retries=3 \
  CMD node -e "const u=process.env.TLS_CERT&&require('fs').existsSync(process.env.TLS_CERT)?require('https'):require('http');u.get({host:'127.0.0.1',port:process.env.PORT||5020,path:'/healthz',rejectUnauthorized:false},r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"
CMD ["node", "--disable-warning=ExperimentalWarning", "server/main.mjs"]
