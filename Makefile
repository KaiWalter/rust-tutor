# rust-tutor — build / run / logs / health / test (docker only; toolchain lives in the image)
#
# LAN-only HTTPS on kai-lenovo:5020, same local CA certificate as duotronic-web
# (~/.local/share/lan-tls). Host networking, like duotronic-web: Docker's
# userland proxy here has no IPv6 and would rewrite every IPv6 client to
# 172.17.0.1, which makes a source-IP allowlist meaningless. The server binds
# [::] with ipv6Only=false, i.e. one dual-stack socket for 0.0.0.0 and [::].
# Host networking also lets the backend reach pi-task-runner on 127.0.0.1:4930.
IMAGE    ?= rust-tutor:latest
NAME     ?= rust-tutor
PORT     ?= 5020
DATA     ?= $(HOME)/.local/share/rust-tutor
CERT_DIR ?= $(HOME)/.local/share/lan-tls
RUNNER   ?= http://127.0.0.1:4930
HOSTNAME_LAN ?= kai-lenovo.fritz.box
CURL     := curl -fsS --cacert $(CERT_DIR)/ca.crt

# Sandbox envelope around student code (per-run rlimits live in server/rustc.mjs):
# --init reaps orphaned zombies, --pids-limit contains fork bombs, --memory caps
# the whole container, /tmp is the only writable+exec place (compile dirs).
SANDBOX_FLAGS = --init --pids-limit 256 --memory 2g --memory-swap 2g --cpus 2 \
  --read-only --tmpfs /tmp:rw,exec,nosuid,nodev,size=512m \
  --cap-drop ALL --security-opt no-new-privileges

.PHONY: build run stop restart logs health test test-host check-lessons verify-access smoke soak

build:
	docker build -t $(IMAGE) .

run: build
	@test -r $(CERT_DIR)/server.crt -a -r $(CERT_DIR)/server.key || (echo "no LAN certificate in $(CERT_DIR)" >&2; exit 2)
	mkdir -p $(DATA)
	-docker rm -f $(NAME) 2>/dev/null || true
	docker run -d --name $(NAME) --restart always \
	  --network host \
	  --user $$(id -u):$$(id -g) \
	  $(SANDBOX_FLAGS) \
	  -e PORT=$(PORT) -e RUNNER_URL=$(RUNNER) \
	  -v $(DATA):/data \
	  -v $(CERT_DIR)/server.crt:/certs/server.crt:ro \
	  -v $(CERT_DIR)/server.key:/certs/server.key:ro \
	  $(IMAGE)
	@echo "rust-tutor up: https://$(HOSTNAME_LAN):$(PORT)/ (LAN only)"

stop:
	-docker rm -f $(NAME)

restart: stop run

logs:
	docker logs -f $(NAME)

health:
	@$(CURL) https://localhost:$(PORT)/healthz && echo

# Full suite inside the image (real rustc/rustfmt), same sandbox envelope as prod.
test: build
	docker run --rm $(SANDBOX_FLAGS) $(IMAGE) \
	  node --disable-warning=ExperimentalWarning --test 'tests/*.test.mjs'

# Host-only subset (rustc-backed tests skip themselves).
test-host:
	node --disable-warning=ExperimentalWarning --test 'tests/*.test.mjs'

# Every challenge: reference passes, starter fails (and predict answers agree with rustc).
check-lessons: build
	docker run --rm $(SANDBOX_FLAGS) $(IMAGE) node --disable-warning=ExperimentalWarning scripts/check-lessons.mjs

# Loopback/LAN must be 200, a docker-bridge client 403, tailscale0 must not answer.
verify-access:
	@printf 'localhost             -> '; curl -s -o /dev/null -w '%{http_code}\n' --cacert $(CERT_DIR)/ca.crt https://localhost:$(PORT)/healthz
	@printf '$(HOSTNAME_LAN) (v4) -> '; curl -4 -s -o /dev/null -w '%{http_code}\n' --cacert $(CERT_DIR)/ca.crt https://$(HOSTNAME_LAN):$(PORT)/healthz --resolve $(HOSTNAME_LAN):$(PORT):$$(ip -4 -o addr show scope global | grep -v -E 'docker|br-|tailscale|veth' | awk '{print $$4}' | cut -d/ -f1 | head -1)
	@printf '$(HOSTNAME_LAN) (v6) -> '; curl -6 -s -o /dev/null -w '%{http_code}\n' --cacert $(CERT_DIR)/ca.crt https://$(HOSTNAME_LAN):$(PORT)/healthz --resolve "$(HOSTNAME_LAN):$(PORT):[$$(ip -6 -o addr show scope global | grep -v -E 'docker|br-|tailscale|veth' | awk '{print $$4}' | cut -d/ -f1 | head -1)]"
	@printf 'docker bridge         -> '; docker run --rm --network bridge curlimages/curl:latest -sk -o /dev/null -w '%{http_code}\n' https://172.17.0.1:$(PORT)/healthz
	@ts=$$(ip -4 -o addr show tailscale0 2>/dev/null | awk '{print $$4}' | cut -d/ -f1); \
	  printf 'tailscale0 %s -> ' "$$ts"; \
	  curl -sk -o /dev/null -m 5 -w '%{http_code}\n' https://$$ts:$(PORT)/healthz || echo "(connection refused/reset: not reachable)"

# End-to-end API smoke against the running container (format/check/run/verify/limits).
smoke:
	CA=$(CERT_DIR)/ca.crt BASE=https://localhost:$(PORT) node scripts/smoke.mjs

# Browser smoke (Monaco markers etc.). Needs PLAYWRIGHT_CORE + CHROMIUM (not deps).
soak:
	CA=$(CERT_DIR)/ca.crt BASE=https://$(HOSTNAME_LAN):$(PORT) node scripts/browser-smoke.mjs
