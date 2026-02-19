# OpenClaw Gateway 配置指南

## 概述

AionUi 通过 WebSocket 连接 OpenClaw Gateway。Gateway 可以在本地运行（自动启动），也可以部署在远程服务器上。

配置文件路径：`~/.openclaw/openclaw.json`（支持 JSONC 注释语法）。

## 认证流程

OpenClaw Gateway 采用**基于设备的认证**模型：

1. **共享 Token/密码** — 在 `openclaw.json` 中配置，用于首次连接认证
2. **设备身份** — AionUi 自动生成密钥对（存储在 `~/.openclaw/`），每次连接时用私钥签名
3. **设备 Token** — 首次认证成功后，Gateway 返回设备专属 Token，本地存储，后续连接优先使用

`openclaw.json` 中的 token 是**服务端设置的共享密钥**，所有客户端使用同一个 token 做首次认证。握手完成后，每个设备会获得自己的专属 token。

```
首次连接：共享 token + 设备签名 → hello-ok + 设备 token
后续连接：设备 token + 设备签名 → hello-ok（+ 刷新）
```

## 配置结构

OpenClaw 使用 `gateway.mode` 字段区分本地和远程模式，远程连接信息放在 `gateway.remote` 子对象中：

```json
{
  "gateway": {
    "mode": "local | remote",
    "port": 18789,
    "auth": {
      "mode": "none | token | password",
      "token": "...",
      "password": "..."
    },
    "remote": {
      "url": "ws://...",
      "token": "...",
      "password": "..."
    }
  }
}
```

## 配置示例

### 示例 1：本地 Gateway（零配置）

无需配置文件，AionUi 自动启动本地 Gateway 进程。

```
结果：
  mode     = local（默认）
  url      = ws://localhost:18789
  external = false → 自动启动 Gateway
  auth     = 无
```

### 示例 2：本地 Gateway 自定义端口 + Token 认证

```json
{
  "gateway": {
    "mode": "local",
    "port": 9999,
    "auth": {
      "mode": "token",
      "token": "your-local-token"
    }
  }
}
```

```
结果：
  mode     = local
  url      = ws://localhost:9999
  external = false → 自动启动或检测已有进程
  auth     = token（从 gateway.auth.token 读取）
```

### 示例 3：连接远程 Gateway（推荐方式）

```json
{
  "gateway": {
    "mode": "remote",
    "remote": {
      "url": "ws://192.168.1.100:18789",
      "token": "your-shared-token"
    }
  }
}
```

```
结果：
  mode     = remote
  url      = ws://192.168.1.100:18789
  external = true
  auth     = token（从 gateway.remote.token 读取）
```

### 示例 4：加密远程连接 (wss://)

```json
{
  "gateway": {
    "mode": "remote",
    "remote": {
      "url": "wss://ai.example.com",
      "token": "your-shared-token"
    }
  }
}
```

```
结果：
  mode     = remote
  url      = wss://ai.example.com
  external = true
  auth     = token（TLS 加密传输）
```

### 示例 5：远程密码认证

```json
{
  "gateway": {
    "mode": "remote",
    "remote": {
      "url": "ws://192.168.1.100:18789",
      "password": "your-password"
    }
  }
}
```

## 配置参考

### `gateway` 对象

| 字段     | 类型   | 默认值  | 说明                         |
| -------- | ------ | ------- | ---------------------------- |
| `mode`   | string | `local` | `"local"` 或 `"remote"`      |
| `port`   | number | `18789` | Gateway 端口（本地模式使用） |
| `auth`   | object | —       | 本地模式认证配置             |
| `remote` | object | —       | 远程模式连接配置             |

### `gateway.auth` 对象（本地模式）

| 字段       | 类型   | 可选值                      | 说明                     |
| ---------- | ------ | --------------------------- | ------------------------ |
| `mode`     | string | `none`, `token`, `password` | 认证方式                 |
| `token`    | string | —                           | 共享 token（mode=token） |
| `password` | string | —                           | 密码（mode=password）    |

### `gateway.remote` 对象（远程模式）

| 字段             | 类型   | 说明                 |
| ---------------- | ------ | -------------------- |
| `url`            | string | 远程 WebSocket URL   |
| `token`          | string | 远程认证 token       |
| `password`       | string | 远程认证密码         |
| `tlsFingerprint` | string | TLS 证书指纹（可选） |
| `sshTarget`      | string | SSH 隧道目标（可选） |
| `sshIdentity`    | string | SSH 密钥路径（可选） |

## 配置值优先级

每个配置值按以下优先级链解析（取第一个非空值）：

```
mode:     UI 传入 → gateway.mode → wizard.lastRunMode → 自动推断 → "local"
url:      UI 传入 → gateway.remote.url（remote 模式） → ws://localhost:{port}
token:    UI 传入 → gateway.remote.token / gateway.auth.token（按 mode）
password: UI 传入 → gateway.remote.password / gateway.auth.password（按 mode）
port:     UI 传入 → gateway.port → 18789
```

## 模式推断规则

当 `gateway.mode` 未显式设置时，按以下规则自动推断：

| 条件                             | 推断 mode |
| -------------------------------- | --------- |
| `gateway.remote.url` 存在        | `remote`  |
| `wizard.lastRunMode` 为 `remote` | `remote`  |
| 旧配置中存在 `gateway.url`       | `remote`  |
| 其他情况                         | `local`   |

## 向后兼容

旧版配置（使用 `gateway.url` / `gateway.host` / `gateway.auth`）仍然受支持：

```json
{
  "gateway": {
    "url": "ws://192.168.1.100:18789",
    "auth": {
      "mode": "token",
      "token": "your-shared-token"
    }
  }
}
```

此配置会被自动推断为 `remote` 模式，token 从 `gateway.auth.token` 回退读取。建议迁移到新的 `gateway.mode` + `gateway.remote` 结构。

## 服务端部署

在远程服务器上启动 Gateway：

```bash
# 无认证
openclaw gateway --port 18789

# Token 认证
openclaw gateway --port 18789 --auth-token "your-shared-token"

# 密码认证
openclaw gateway --port 18789 --auth-password "your-password"
```

共享 token/密码在启动 Gateway 时设置，所有客户端使用相同的共享凭证进行首次认证。
