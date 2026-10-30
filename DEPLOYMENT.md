# Server Harbor 新环境部署指南

适用版本：当前本地项目 `server-harbor@2.0.0`。编写日期：2026-10-30。

本文按照当前代码编写，覆盖 macOS、Ubuntu/Debian、RHEL/Rocky/AlmaLinux/Fedora、Windows、Docker，以及远程 MySQL、旧数据迁移、备份和排错。

**先看部署状态：macOS 本地安装已有自动初始化脚本；Linux、Windows 原生和 Docker 需要额外准备秘密管理器及读取适配器。仓库目前没有这些平台的完整一键安装程序，Docker 模板也尚未在真实环境验收。本文会标出这些前置条件，不能把“已给出配置示例”理解为“所有平台均已实测通过”。**

如果只是把现有项目放到另一台 Mac 本地使用，从第 4 章开始；如果要迁移已有服务器和历史录制，先读第 12 章，不能重新生成主密钥。

## 目录

1. [部署方式与系统选择](#s1)
2. [组件、端口与部署前准备](#s2)
3. [密码、VAULT_KEY 与配置文件](#s3)
4. [macOS：全新本地安装](#s4)
5. [Ubuntu / Debian：安装运行环境](#s5)
6. [RHEL / Rocky / AlmaLinux / Fedora](#s6)
7. [Linux 原生：数据库、秘密管理器、应用与服务](#s7)
8. [Windows 10 / 11 与 Windows Server](#s8)
9. [Docker：跨系统容器部署](#s9)
10. [公网 HTTPS、反向代理与防火墙](#s10)
11. [远程 / 云 MySQL 的 TLS 连接](#s11)
12. [旧环境迁移到新环境](#s12)
13. [备份、恢复与密钥保管](#s13)
14. [首次登录与功能配置](#s14)
15. [启动、停止、更新与回滚](#s15)
16. [常见错误逐项处理](#s16)
17. [部署验收与安全边界](#s17)
18. [配置速查与命令速查](#s18)

<a id="s1"></a>

## 1. 部署方式与系统选择

### 1.1 先分清三个场景

| 场景 | 数据库 | VAULT_KEY | 操作方式 |
| --- | --- | --- | --- |
| 全新、独立的一套系统 | 新库，不恢复旧数据 | 生成新的随机主密钥 | 按本系统安装章节执行 |
| 更换机器，保留原服务器、账号、录制 | 新库恢复旧数据，或继续连接原库 | **必须使用旧主密钥** | 按第 12 章迁移 |
| 只更新程序版本 | 原库 | 保留原值 | 备份后更新代码、安装依赖、构建、重启 |

即使目标数据库刚刚安装，只要导入了旧凭据，就属于“迁移”，不能当作全新系统重新生成密钥。

### 1.2 各类系统如何选择

| 系统 / 方式 | 建议用途 | 当前代码情况 |
| --- | --- | --- |
| macOS Intel / Apple Silicon 原生 | 本地使用、开发 | `npm run setup` 使用系统钥匙串；新机器仍需按本文验收 |
| Ubuntu 24.04 LTS / Debian 12、13 原生 | Linux 服务器 | Node/MySQL 可按下文安装；需自己接入秘密管理器、开户及 systemd |
| RHEL 9/10、Rocky / AlmaLinux 对应受维护版本 | Linux 服务器 | 原理同上；包源、SELinux、服务名需按系统确认 |
| CentOS Stream 9/10、受维护的 Fedora | 熟悉对应发行版的运维环境 | 按对应 DNF 包源安装，不照搬 Ubuntu 命令 |
| Windows 11，或仍获得安全更新的 Windows 10 + WSL2 | Windows 本地使用、开发 | 建议进入 Ubuntu WSL 后按 Linux 流程；钥匙串脚本不可用 |
| Windows 原生 Node + MySQL | 有 Windows 运维经验时 | 需 Windows 可执行秘密读取程序；未提供安装器和服务注册脚本 |
| Windows Server | 长期运行 | 建议创建 Linux 虚拟机，再按 Linux 原生或 Docker 流程 |
| Linux Docker Engine + Compose | 统一打包、未来公网部署 | 已有镜像和 Compose；**秘密适配器、数据库出网及实际验收尚需完成** |
| macOS / Windows Docker Desktop | 容器开发、部署演练 | 与 Linux 容器共用配置，不能直接读取宿主 Mac 钥匙串 |
| openSUSE、Arch、其他 Linux | 有对应运维经验时 | 可采用 Docker 或原生通用流程；本文不承诺这些发行版已验证 |
| Alibaba Cloud Linux / TencentOS / openEuler / Anolis 等 | 云主机或国产 Linux 环境 | 先确认发行版版本、CPU 架构、glibc、Node/MySQL 和容器支持；不能仅凭使用 DNF 就套用其他系统仓库 |

Windows Server 不使用 Docker Desktop。Docker 官方不支持在 Windows Server 上运行 Desktop；本项目提供的是 Linux 容器镜像。[Docker Windows 安装与支持范围](https://docs.docker.com/desktop/setup/install/windows-install/)

### 1.3 版本建议

- Node.js：使用 **Node 22 系列最新安全补丁版，且不低于 22.12**，与当前 Dockerfile 的大版本一致。项目只声明最低版本，不代表所有更高版本都经过测试。
- 不要沿用旧环境的 Node 23 作为新部署版本。官方已将它列为 EOL。Node 24/26 的切换应先验证依赖，再同步修改镜像和运行环境。
- MySQL：新环境优先选择 MySQL 8.4 LTS，容器模板使用 `mysql:8.4`。不要把系统默认装出的 MariaDB 当作本项目已经验证过的 MySQL 替代品。
- 当前模板只有一个 Node 网关实例。不要直接增加副本或在多个实例间随机转发 SSH / WebSocket。

Node 的生命周期会变化，安装时复查 [官方发布列表](https://nodejs.org/en/about/previous-releases) 和 [Node 22 下载页](https://nodejs.org/en/download/archive/v22)。不要把本文的版本建议无限期沿用。

<a id="s2"></a>

## 2. 组件、端口与部署前准备

### 2.1 项目实际由什么组成

前端是 React/Vite，由 Node.js 构建；后端是 Node.js/Express；数据库是 MySQL。生产启动时 Node 直接提供 `dist/` 内的界面，不需要另外启动 Vite。

```text
浏览器 ── HTTPS / WSS ── Caddy ── 本机或容器内 HTTP 4317 ── Node
Termius ── SSH 2222（公网示例）─────────────────────────── SSH 网关
                                                           │
                             MySQL ← Unix socket / TLS ────┤
                             秘密管理器 ← 读取启动秘密 ──────┤
                             目标服务器 ← SSH 22 或自定端口 ─┘
```

监控目标目前只支持 Linux。管理平台本身部署在 Windows 或 macOS，不意味着可以监控 Windows 服务器的 CPU/内存。

### 2.2 规划资源与端口

小团队试用可从 2 核、4 GB 内存、20 GB 以上可用空间起步，这是容量规划起点，并非压测结论。录制会持续占用磁盘；默认单次上限 32 MB，目前没有自动清理策略。

| 端口 | 用途 | 本地模式 | 公网部署 |
| --- | --- | --- | --- |
| TCP 4317 | Node HTTP / API / WebSocket | 只监听回环 | 仅 Caddy 可访问，不直接开放公网 |
| TCP 4320 | Node SSH 网关内部端口 | 只监听回环 | 容器内部使用；原生可选其他端口 |
| TCP 2222 | 示例公网 SSH 网关端口 | 不需要 | 供成员 Termius 连接，限制到团队来源 IP / VPN |
| TCP 80、443 | HTTPS 证书申请、页面、网页 SSH | 不需要 | 指向 Caddy |
| TCP 3306 | MySQL TCP | 仅本机，或使用 socket | 不对公网开放；远程库走内网及 TLS |
| TCP 5173 | Vite 开发界面 | 仅开发 | 不部署到公网 |

另有部署主机本身的系统 SSH 管理端口，通常是 22。它与本项目的 Termius 网关端口不同，防火墙操作前先保留自己的系统管理入口。

### 2.3 准备清单

1. 确认是全新安装还是迁移，记录系统版本和 CPU 架构。
2. 准备可信的项目源码、`package.json` 和 `package-lock.json`。
3. 准备系统管理员 / sudo 权限和数据库初始化权限。
4. 公网使用准备真实域名，例如把本文 `ops.example.com` 全部替换为自己的域名。
5. Linux / Windows / Docker 先确定秘密管理器，例如云厂商 Secret Manager / KMS 支持的秘密服务、企业 Vault 或操作系统秘密服务。**只有 KMS 的加解密 API，不等于已经有本项目需要的秘密读取适配器。**
6. 迁移时，确认原 `VAULT_KEY`、数据库备份、网关加密密钥和录制都可恢复。
7. 配置系统时间同步；数据库连接使用 UTC，登录锁定按北京时间自然日判断。

### 2.4 整理源码包

在现有 Mac 上执行以下打包命令，仅包含源码和公开配置示例：

```bash
cd ~/codes/server-harbor
tar --exclude='./node_modules' --exclude='./dist' --exclude='./.data' \
    --exclude='./.git' --exclude='./.idea' --exclude='./.DS_Store' \
    --exclude='./.env' --exclude='./.env.*' --exclude='./deploy/secrets-provider' \
    --exclude='*.log' \
    -czf ~/Desktop/server-harbor-source.tar.gz .
tar -tzf ~/Desktop/server-harbor-source.tar.gz
```

此命令也会排除 `.env.example` 和 `.env.production.example`；下文提供了完整公开配置，不依赖这两个文件才能部署。先检查包内容，确认没有人为另存的密码文件、私钥、数据库导出或秘密管理器凭据，再传输。

新环境重新运行 `npm ci`、`npm run build`。不要跨系统复制 `node_modules`。此源码包不包含迁移数据；迁移资料按第 12 章另外通过受保护通道传输。

如果项目以后有真实 Git 仓库，可以使用自己的仓库地址拉取；本文不提供虚构的 `git clone` 地址。

<a id="s3"></a>

## 3. 密码、VAULT_KEY 与配置文件

### 3.1 这些秘密各自有什么用途

| 名称 | 用途 | 谁需要 | 保存位置 |
| --- | --- | --- | --- |
| MySQL 管理员密码 | 建库、开户、必要的恢复 | 部署者 / DBA | 受保护的秘密管理器；应用日常不使用 |
| `MYSQL_PASSWORD` / `MYSQL_APP_PASSWORD` | 专用数据库账号密码，同一个用途的两种接口名称 | Node 应用；容器初始化也读取 | Mac 钥匙串或外部秘密管理器 |
| `VAULT_KEY` | 加解密 SSH 凭据、云 Secret、录制、网关私钥、加密备份 | Node 应用、备份恢复流程 | 同上，必须另做受保护的恢复准备 |
| `BOOTSTRAP_TOKEN` | 公网首次创建管理员时证明部署者身份 | 应用和首次初始化人 | 秘密管理器；不写进 URL |
| 网页账号密码 | 成员登录平台 | 成员 | 数据库存 scrypt 哈希，不保存可解密原密码 |
| 目标服务器 SSH 密码 / 私钥 | 网关登录目标服务器 | Node 在连接时解密使用 | 数据库存 AES-256-GCM 密文 |

`VAULT_KEY` 必须是加密安全随机生成的 **32 字节，使用 64 位十六进制文本表示**。不能把网页登录密码、数据库密码、32 个普通字符或自己编的短句当作主密钥。

### 3.2 到底在哪里配置

- **Mac 全新本地安装**：运行 `npm run setup` 自动生成应用数据库密码和 `VAULT_KEY`，写进当前用户的系统钥匙串。`.env` 保存 `HARBOR_KEYCHAIN_ACCOUNT` 引用。
- **Linux / Windows / Docker**：先由秘密管理器安全生成或导入这些值，配置 `HARBOR_SECRET_PROVIDER` 指向读取适配器；应用启动时从适配器读取。
- **迁移**：把原主密钥安全导入目标秘密管理器。数据库应用密码可以重新开户后更换；主密钥不能随意更换。

Mac 钥匙串服务名是 `com.server-harbor.secrets`。存储内容是一个秘密包；内部的 Base64 只是编码，保护来自系统钥匙串。不要把该值复制成 Base64 文件，误认为这样就是加密备份。

### 3.3 配置文件只能放公开参数

可以放：端口、数据库地址/用户名/库名、socket 路径、域名、CA 公共证书路径、秘密读取程序路径、钥匙串引用。

不能放：`MYSQL_PASSWORD`、`MYSQL_APP_PASSWORD`、`MYSQL_ROOT_PASSWORD`、`VAULT_KEY`、`BOOTSTRAP_TOKEN` 的实际值。当前程序检测到 `.env` 内有这些非空值会拒绝启动。

也不要把密码写进 Compose `environment`、Dockerfile、systemd `Environment=`、PowerShell profile、shell profile、启动参数或 `.sql` 文件。给文件设 `0600` 是访问控制，不是加密。

进程的环境变量优先级高于秘密管理器返回值。旧终端、IDE 或服务里遗留的秘密环境变量可能覆盖新配置，排错时只检查变量名称和来源，不打印所有环境变量。

### 3.4 “不明文保存”的准确边界

本项目的部署目标是：秘密不以明文持久化在项目配置、日志、备份和容器配置中；运行时仍需在内存中使用解密后的凭据。TLS 保护传输，钥匙串 / 秘密管理器保护启动秘密，应用加密保护数据库中的远程凭据，三者作用不同。

系统管理员、被攻陷的应用进程、调试器或内存转储仍可能接触运行时秘密。部署时启用系统磁盘加密、限制调试与转储权限，不保存带秘密的故障快照。数据库安装器、SQL 客户端历史和第三方审计插件也有自己的日志规则，应单独检查，不能笼统承诺任意第三方软件绝不会落盘秘密。[MySQL 密码与日志说明](https://dev.mysql.com/doc/refman/8.4/en/password-logging.html)

<a id="s4"></a>

## 4. macOS：全新本地安装

**本章只适用于完全独立的新安装。要保留旧数据，先按第 12 章迁移。**

### 步骤 1：安装 Node.js

1. 打开 [Node 22 官方下载页](https://nodejs.org/en/download/archive/v22)。
2. 在所选最新补丁版的下载项中选择 macOS 安装包或对应架构文件：Apple Silicon 选 arm64，Intel 选 x64。
3. 完成安装后重新打开终端；如使用 nvm，确认当前终端和 IDE 都选择 Node 22。

```bash
uname -m
node -v
npm -v
command -v node
```

应看到 Node `v22.x` 且不低于 22.12。不要只安装 Node 而继续让 IDE 指向旧的 Node 23 路径。

### 步骤 2：安装并启动 MySQL

1. 从 MySQL 官方选择 MySQL 8.4 的 macOS 安装包，匹配芯片和系统。
2. 按安装向导初始化数据库，设置独立的强管理员密码，通过系统设置中的 MySQL 面板启动服务。
3. 管理员密码保存在密码管理器，不写到项目文件。
4. 把客户端路径加入当前终端的 PATH；官方安装包通常在 `/usr/local/mysql/bin`，以实际安装位置为准。

```bash
export PATH="/usr/local/mysql/bin:$PATH"
mysql --version
mysql --protocol=TCP -h 127.0.0.1 -P 3306 -u root -p
```

最后一条会交互提示密码，`-p` 后面**不要跟真实密码**。登录后执行：

```sql
SELECT VERSION(), @@port, @@socket;
EXIT;
```

若使用 Homebrew 安装的 MySQL，只使用那套安装的服务管理方式和客户端路径，不要同时启动另一套官方包服务。[MySQL macOS 官方安装步骤](https://dev.mysql.com/doc/refman/8.4/en/macos-installation-pkg.html)

**当前 `setup` 固定连接 `127.0.0.1:3306`，使用 root 密码认证。** 自定义数据库端口、远程 MySQL、root 不能通过本机 TCP 登录时，不能直接运行这个脚本，需要按手工开户和秘密管理器流程处理。

### 步骤 3：放入项目并安装依赖

以下假设源码包已在桌面。目标目录应是新建目录；不要把新包解压覆盖到保存旧数据的目录。

```bash
mkdir -p ~/codes/server-harbor
cd ~/codes/server-harbor
tar -xzf ~/Desktop/server-harbor-source.tar.gz
npm ci
```

如果源码已通过其他方式放入该目录，只执行 `cd` 和 `npm ci`。

### 步骤 4：初始化数据库与主密钥

**先不要手动创建 `.env`，也不要先执行 `cp .env.example .env`。** 脚本只要发现 `.env` 已存在，就会跳过初始化，即使文件为空。

```bash
npm run setup
```

在隐藏输入提示中输入这台新机器的 MySQL root 密码。脚本会：

1. 检查 `server_harbor` 数据库及同名数据库用户是否已存在；存在则停止保护现有数据。
2. 随机生成应用数据库密码和主密钥，写入当前 Mac 用户的钥匙串，并验证可读。
3. 创建 `server_harbor` 数据库，以及 `server_harbor@127.0.0.1`、`server_harbor@localhost` 两个账户。
4. 授予本项目所需的库内权限。
5. 查询 MySQL socket 路径，把公开连接配置和钥匙串引用写入 `.env`。

钥匙串弹出访问提示时，确认发起者是你刚启动的受信任 Node 运行程序，再按系统提示授权。更换 Node 路径或版本后可能再次请求访问。

成功标志是终端显示数据库和专用账号已创建、秘密保存在钥匙串。**无需再手工生成或填写 `VAULT_KEY`。**

若中途失败，可能已经写入钥匙串或创建部分数据库对象；不要删除数据库后盲目重试。先按第 16 章检查。

### 步骤 5：理解 socket 配置

`.env` 可能包含：

```dotenv
PORT=4317
BRIDGE_PORT=4320
MYSQL_HOST=127.0.0.1
MYSQL_PORT=3306
MYSQL_SOCKET_PATH=/tmp/mysql.sock
MYSQL_USER=server_harbor
MYSQL_DATABASE=server_harbor
HARBOR_KEYCHAIN_ACCOUNT=脚本实际生成的引用
```

这只是结构示意，**不要拿示意引用覆盖脚本生成的真实值**。socket 路径也以脚本查询到的结果为准。

`/tmp/mysql.sock` 是 MySQL 服务启动时创建的本机通信端点，不是项目创建的密码文件，也不是数据库数据文件。`SELECT @@socket;` 只查询路径，不会创建连接加密。不要手动 `touch` 一个同名文件，也不要从旧机器复制 socket。[MySQL 连接方式说明](https://dev.mysql.com/doc/refman/8.4/en/connecting.html)

### 步骤 6：构建并启动

```bash
npm run build
npm start
```

终端保持运行，打开：`http://127.0.0.1:4317`。

另开一个终端检查：

```bash
curl --fail http://127.0.0.1:4317/api/health
```

预期返回 `{"ok":true}`。首次进入创建管理员，账号 3–64 位，密码至少 10 个字符，建议使用密码管理器生成更长的独立密码。

### 步骤 7：在 IDE 中启动

1. 打开项目根目录。
2. Node 解释器选择刚安装的 Node 22。
3. npm 配置选择根目录 `package.json`，脚本选择 `start`，工作目录选择项目根目录。
4. 先停止其他终端或 IDE 中的旧实例，再点击运行。
5. 更新代码后先 `npm run build`，再重启 `start`。

同一套配置只启动一次。`EADDRINUSE` 表示端口被占用，不是数据库密码错误。

本地开发时才使用 `npm run dev`。不要同时运行 `dev` 和 `start`，它们都会尝试启动后端和 SSH 网关。

Mac 本地流程依赖登录用户的钥匙串，不保证在开机未登录、系统 LaunchDaemon 或容器中自动解锁。无人值守公网运行建议选择 Linux 服务和外部秘密管理器。

<a id="s5"></a>

## 5. Ubuntu / Debian：安装运行环境

本章用于原生部署。若选择 Docker，安装 Docker 后跳转第 9 章，不需要在宿主机另外安装 Node/MySQL。

### 步骤 1：查看系统并安装工具

```bash
cat /etc/os-release
uname -m
sudo apt update
sudo apt install -y ca-certificates curl xz-utils tar
```

如果依赖安装明确需要本机编译，再安装 `build-essential` 和 `python3`。不要为解决普通 npm 错误随意更换包源或关闭证书校验。

### 步骤 2：安装 Node 22

可以使用组织已经维护的 Node 22 包源，或从 [Node 官方发布目录](https://nodejs.org/dist/latest-v22.x/) 下载 Linux 二进制。下面只适用于**没有其他 Node 安装冲突的全新机器**，自动根据架构选择 x64 / arm64 文件：

```bash
mkdir -p ~/harbor-install/node22
cd ~/harbor-install/node22
case "$(uname -m)" in
  x86_64) harbor_node_arch=x64 ;;
  aarch64|arm64) harbor_node_arch=arm64 ;;
  *) echo '此示例仅覆盖 x64 和 arm64'; exit 1 ;;
esac
curl -fSLo SHASUMS256.txt https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt
harbor_node_archive=$(awk -v arch="$harbor_node_arch" '$2 ~ ("-linux-" arch "\\.tar\\.xz$") {print $2}' SHASUMS256.txt)
test -n "$harbor_node_archive"
curl -fSLO "https://nodejs.org/dist/latest-v22.x/$harbor_node_archive"
awk -v file="$harbor_node_archive" '$2 == file' SHASUMS256.txt | sha256sum -c -
```

仅在校验显示 `OK` 后解压安装：

```bash
sudo tar --extract --xz --file "$harbor_node_archive" \
  --directory /usr/local --strip-components=1 --no-same-owner
/usr/local/bin/node -v
/usr/local/bin/npm -v
```

同一下载源提供的 SHA256 可检查下载完整性，不能替代发布签名验证；要求更高时再按 Node 下载页的 Signed SHASUMS 流程验证。系统原有 Node、企业包管理策略、非 glibc 系统不适合直接执行此安装示例。

### 步骤 3：安装 MySQL 8.4

先从 [MySQL APT 仓库下载页](https://dev.mysql.com/downloads/repo/apt/) 取得适合系统的仓库配置 `.deb`，核对官方说明，替换下方文件名为实际下载文件：

```bash
sudo dpkg -i ./mysql-apt-config_实际版本_all.deb
```

在版本选择中明确选择 MySQL 8.4 LTS，再执行：

```bash
sudo apt update
sudo apt install mysql-server mysql-client
sudo systemctl enable --now mysql
sudo systemctl status mysql --no-pager
mysql --version
```

Debian/Ubuntu 自带的 `default-mysql-server`、`mysql-server` 可能对应不同产品或版本，因此先配置并检查官方仓库，不能只看包名。[MySQL APT 官方安装指南](https://dev.mysql.com/doc/mysql-apt-repo-quick-guide/en/)

管理员登录方式取决于安装时选择：

```bash
# root 使用本机系统身份认证时：
sudo mysql
```

或者：

```bash
# root 已配置密码认证时：
mysql -u root -p
```

在 MySQL 中查询版本与 socket，然后退出：

```sql
SELECT VERSION(), @@socket;
EXIT;
```

**不要为了适配 Mac 的 setup 脚本而把 Linux root 改成弱密码或打开 root 远程登录。** 下一步按第 7 章开户和配置秘密管理器。

<a id="s6"></a>

## 6. RHEL / Rocky / AlmaLinux / Fedora

### 步骤 1：基础工具与 Node

```bash
cat /etc/os-release
uname -m
sudo dnf install -y ca-certificates curl tar xz
```

Node 可按第 5 章的官方 Linux 二进制流程安装到 `/usr/local`。如果使用发行版 Node 模块流，先查看可用版本，确认实际为 22 且不低于 22.12；不要无条件执行系统默认的 `dnf install nodejs` 后就当作版本合格。

### 步骤 2：MySQL

1. 从 [MySQL Yum 仓库下载页](https://dev.mysql.com/downloads/repo/yum/) 获取适配当前发行版 / 主版本的仓库 RPM。
2. 对受支持的系统安装该 RPM，检查启用的是 8.4 LTS 仓库。
3. 安装、启动，并核对实际版本。

```bash
sudo dnf install ./mysql84-community-release-实际平台版本.noarch.rpm
sudo dnf repolist enabled
sudo dnf install mysql-community-server mysql-community-client
sudo systemctl enable --now mysqld
sudo systemctl status mysqld --no-pager
mysql --version
```

包名中的版本和平台以上游实际下载项为准。若启用了发行版自带 MySQL 模块流、已有 MariaDB 或 MySQL，不要直接卸载或覆盖数据，应先评估冲突和备份。[MySQL Yum 官方安装指南](https://dev.mysql.com/doc/mysql-yum-repo-quick-guide/en/)

RPM 安装的首次管理员初始化可能涉及安装器生成的临时凭据。按官方初始化流程在受保护终端中取得并立即更换，不把包含临时凭据的日志复制进工单、本文或项目；确认初始化日志的保留策略。

Rocky / AlmaLinux 是兼容发行版，是否能用某个官方仓库需要按其版本实际核实，不把 RHEL 的官方支持范围直接等同于所有兼容系统。源不匹配时可以选择受支持的 Linux 虚拟机或容器路线。

### 步骤 3：CentOS 与其他兼容系统的区别

CentOS Stream 与已经结束维护的 CentOS Linux 是不同产品。新公网环境不选择已停止安全更新的旧 CentOS Linux；不要为安装新 Node 通过替换 glibc 来冒险修补旧系统。先升级到受维护系统，再部署本项目。[CentOS Linux 生命周期说明](https://www.centos.org/centos-linux-eol/)

CentOS Stream 9/10 可使用对应的 Docker CentOS 仓库，具体命令见第 9 章。Alibaba Cloud Linux、TencentOS、openEuler、Anolis 等先查本发行版的官方包源 / 容器说明；原生应用层仍按第 7 章配置，但仓库 RPM、服务名、SELinux 和 CPU 架构必须匹配，不能把一个发行版的 repo 文件当作全部系统通用安装包。

### 步骤 4：SELinux 与 firewalld

保留 SELinux，不以永久关闭它作为部署步骤。文件拒绝访问时检查上下文与审计记录，按最小权限调整。尤其检查应用数据目录、秘密适配器、MySQL socket 和反向代理网络访问。

Node/MySQL 安装完成后进入第 7 章；选择 Docker 则进入第 9 章。不要在同一机器上无意同时运行原生 MySQL 和占用相同端口的另一套数据库。

<a id="s7"></a>

## 7. Linux 原生：数据库、秘密管理器、应用与服务

**本章的前置条件：Node/MySQL 已安装；已选定秘密管理器，并能提供下面定义的适配器。当前仓库没有自动实现这个适配器，也没有 Linux 版 `setup`。没有准备好时可以完成环境安装和源码构建，但不能跳过秘密步骤宣布部署成功。**

### 步骤 1：创建运行身份和项目目录

以下用于新的专用 Linux 部署账号；已由组织创建该账号时不重复创建。

```bash
sudo useradd --system --create-home --home-dir /var/lib/server-harbor \
  --shell /usr/sbin/nologin server-harbor
sudo install -d -o server-harbor -g server-harbor -m 0750 /opt/server-harbor
```

某些发行版 `nologin` 在 `/sbin/nologin`，先确认路径。把已检查的源码包上传至服务器用户可访问的位置，解压到项目目录：

```bash
sudo tar -xzf /tmp/server-harbor-source.tar.gz -C /opt/server-harbor
sudo chown -R server-harbor:server-harbor /opt/server-harbor
cd /opt/server-harbor
sudo -u server-harbor /usr/local/bin/npm ci
sudo -u server-harbor /usr/local/bin/npm run build
sudo -u server-harbor mkdir -p .data
sudo chmod 0700 .data
```

如果 npm 在其他路径，替换为实际安装位置，并保证其调用的 Node 也来自所选版本。

### 步骤 2：在秘密管理器中创建秘密

给这一套环境单独建立命名空间。全新部署创建以下条目；迁移时 `VAULT_KEY` 导入原值：

| 逻辑名称 | 内容要求 |
| --- | --- |
| `MYSQL_APP_PASSWORD` | 为 `server_harbor` 专用数据库账户生成的独立随机密码，建议至少 32 位 |
| `VAULT_KEY` | 随机 32 字节的 64 位十六进制表示 |
| `BOOTSTRAP_TOKEN` | 随机高强度初始化令牌，至少 32 个字符 |
| `MYSQL_ROOT_PASSWORD` | 仅数据库初始化 / 容器数据库需要；不要授给普通应用身份不必要的读取权 |

通过秘密服务的受保护界面或已审核的生成 / 导入流程完成。不要先把随机值打印到终端，再手抄到 `.env`。秘密生成器不支持所需的十六进制格式时，需要增加“随机生成后直接写入秘密服务”的受控工具，不能拿普通随机密码替代 `VAULT_KEY`。

给应用工作负载身份最小读取权限，优先使用实例角色 / 工作负载身份，而不是再在本机放一个长期 AccessKey。首次部署还要确认如何在另一台机器恢复同一主密钥；仅有机器绑定的密文并不一定能异机恢复。

### 步骤 3：准备读取适配器

原生 Linux 示例位置：`/opt/server-harbor-secrets/read-secret`。

适配器的接口是：

```text
绝对路径/read-secret MYSQL_APP_PASSWORD
绝对路径/read-secret VAULT_KEY
绝对路径/read-secret BOOTSTRAP_TOKEN
```

应用每次启动分别调用以上三个名称；**即使本地模式不要求首次令牌，配置了适配器后仍会读取 `BOOTSTRAP_TOKEN`**。Docker MySQL 入口另外读取 `MYSQL_ROOT_PASSWORD`。

实现要求：

1. 用传入名称映射到此环境秘密服务里的条目，只允许已知名称。
2. 使用被验证的 TLS 与工作负载身份读取秘密。
3. 成功仅向 stdout 输出原始秘密及最多一个末尾换行，退出码 0；不要输出 JSON、标签、Base64 包或调试信息。
4. 失败使用非零退出码；错误消息不包含秘密。
5. 单次应在 10 秒内完成；SDK、CLI、CA、身份和网络依赖都必须在运行环境中存在。
6. 源码不嵌入秘密，不先写临时明文文件，不在错误日志或 shell `set -x` 中打印响应。
7. 适配器和依赖由部署管理员维护，应用用户只能执行 / 读取，不应能任意改写它。

这只是通用接口规范，**不是已接通某一家秘密服务的脚本**。例如云 CLI 不会自动出现在服务器或镜像里，必须安装且配置合适身份。仅创建同名空文件不能完成接入。

### 步骤 4：创建数据库与专用账号

使用 DBA 的受保护管理通道建库和开户。**本仓库没有 Linux 安全开户脚本，下面的无密码 SQL 只完成建库 / 授权，不能自动生成账户密码。**

1. DBA 本机登录 MySQL，或使用已校验 TLS / SSH 隧道的管理客户端。
2. 创建 `server_harbor` 数据库，字符集 `utf8mb4`、排序规则 `utf8mb4_unicode_ci`。
3. 在管理客户端的账户管理密码输入框中，为 `server_harbor@localhost` 设置与秘密服务 `MYSQL_APP_PASSWORD` **完全相同**的值，不保存 SQL 编辑器文件或查询历史中的明文密码。
4. 若将使用 TCP `127.0.0.1`，也创建 `server_harbor@127.0.0.1` 并赋相同密码；socket 通常匹配 `localhost`。远程数据库则按 DBA 允许的应用来源配置 Host，不默认开放 `%`。
5. 仅授予本库所需权限。确认数据库日志和所选管理客户端没有额外记录密码。

可在无秘密的 SQL 会话执行：

```sql
CREATE DATABASE server_harbor
  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- 前提：对应账号已通过受保护的管理流程创建。
GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, INDEX, REFERENCES
  ON server_harbor.* TO 'server_harbor'@'localhost';

-- 仅当另建了 TCP 本机账号时执行：
GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, INDEX, REFERENCES
  ON server_harbor.* TO 'server_harbor'@'127.0.0.1';

SHOW GRANTS FOR 'server_harbor'@'localhost';
SELECT @@socket;
```

如果只具备命令行管理条件，应由 DBA 使用**从秘密服务读取、在内存中传给数据库驱动**的开户工具完成 `CREATE USER`，该工具需要另外准备。本文刻意不提供让你把真实密码填入 `.sql`、命令参数或 shell 历史的做法。数据库账号密码和秘密服务中的值不能各自独立生成后忘记同步。

应用不需要日常 root 权限，也不需要对所有库授权。首次启动会自动创建业务表，因此运行账号需要 `CREATE` 等上述权限；当前版本通常不需要 `ALTER`。以后升级仍应复核新版本的迁移要求。

### 步骤 5：写入仅含公开参数的 `.env`

在 `/opt/server-harbor/.env` 写入以下内容。这个例子用于**本地预览**，socket 路径必须改为上一步查询的真实值：

```dotenv
NODE_ENV=development
HOST=127.0.0.1
PORT=4317
PUBLIC_URL=http://127.0.0.1:4317
BRIDGE_PORT=4320
SSH_BIND_HOST=127.0.0.1
SSH_PUBLIC_HOST=127.0.0.1
SSH_PUBLIC_PORT=4320
MYSQL_SOCKET_PATH=/run/mysqld/mysqld.sock
MYSQL_USER=server_harbor
MYSQL_DATABASE=server_harbor
HARBOR_SECRET_PROVIDER=/opt/server-harbor-secrets/read-secret
RECORD_SESSIONS=true
RECORDING_MAX_BYTES=33554432
```

```bash
sudo chown server-harbor:server-harbor /opt/server-harbor/.env
sudo chmod 0600 /opt/server-harbor/.env
```

不要留下 Mac 的 `HARBOR_KEYCHAIN_ACCOUNT`；Linux 无法读取 Mac 钥匙串。使用 socket 还要求应用用户能访问其父目录和通信端点，按 MySQL 的正常权限设计配置，不使用 `chmod 777` 绕过。

### 步骤 6：只验证秘密可读，不打印秘密

从项目目录执行，身份与将来的服务一致：

```bash
sudo -u server-harbor /usr/local/bin/node --input-type=module <<'NODE'
import { loadEnvironment } from './server/secrets.mjs';
try {
  const env = await loadEnvironment();
  if (!env.MYSQL_PASSWORD || !/^[a-f0-9]{64}$/i.test(env.VAULT_KEY || '') ||
      (env.BOOTSTRAP_TOKEN || '').length < 32) throw new Error();
  console.log('秘密可读，格式检查通过；未输出秘密内容。');
} catch {
  console.error('秘密读取或格式检查失败，请检查适配器、身份、权限和网络。');
  process.exitCode = 1;
}
NODE
```

此检查不会测试数据库，也不会修改业务数据。不要为了检查而直接运行 `read-secret VAULT_KEY` 把秘密显示到终端。

### 步骤 7：启动本地预览

```bash
cd /opt/server-harbor
sudo -u server-harbor /usr/local/bin/npm start
```

在服务器另一个终端：

```bash
curl --fail http://127.0.0.1:4317/api/health
```

需要从自己电脑看页面时，通过系统 SSH 建立临时隧道：

```bash
ssh -L 4317:127.0.0.1:4317 部署用户名@部署服务器地址
```

随后在自己电脑打开 `http://127.0.0.1:4317`。这个隧道只是预览页面；本地模式中的 Termius 网关地址仍指向本机，不代表公网网关已部署。

公网生产部署不要先通过 HTTP 创建真实管理员、再临时对外开放。先停止预览，按第 10 章配置 HTTPS 和初始化令牌。

### 步骤 8：注册 systemd 服务

确认前台启动成功后停止前台实例。创建 `/etc/systemd/system/server-harbor.service`，以下示例中的 Node 路径以实际为准：

```ini
[Unit]
Description=Server Harbor
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=server-harbor
Group=server-harbor
WorkingDirectory=/opt/server-harbor
Environment=PATH=/usr/local/bin:/usr/bin:/bin
ExecStart=/usr/local/bin/node /opt/server-harbor/scripts/start.mjs
Restart=on-failure
RestartSec=5
TimeoutStopSec=30
UMask=0077
LimitCORE=0
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

这里不使用 `EnvironmentFile=.env` 把秘密注入服务；应用会从工作目录自行读取公开 `.env`。如果 MySQL socket 在 `/tmp`，`PrivateTmp=true` 会隔离它，改用 `/run/...` 的受管理 socket 路径，或经评估删除该隔离项。秘密服务若依赖 `/tmp` 中的身份代理也要相应评估。

需要严格等待本机数据库时，在 `[Unit]` 中追加实际的 `After=mysql.service` 或 `After=mysqld.service`；远程数据库不写这两个依赖。外部秘密管理器必须允许此服务身份读取。

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now server-harbor
sudo systemctl status server-harbor --no-pager
sudo journalctl -u server-harbor -n 80 --no-pager
```

应用从秘密管理器读取失败会拒绝启动。不要通过把密码塞进 service 文件来绕过。

<a id="s8"></a>

## 8. Windows 10 / 11 与 Windows Server

### 8.1 推荐：Windows 通过 WSL2 运行 Linux 环境

**步骤 1：安装 WSL。** 管理员 PowerShell 中执行：

```powershell
wsl --install -d Ubuntu-24.04
```

按提示重启，首次启动 Ubuntu 时创建 Linux 用户。如果发行版名称不可用，先执行 `wsl --list --online`，选择在线列出的受维护 Ubuntu，再安装。

```powershell
wsl --update
wsl --list --verbose
```

确认所选发行版的 VERSION 为 2。需要转换时使用列表里的真实名称：

```powershell
wsl --set-version Ubuntu-24.04 2
wsl -d Ubuntu-24.04
```

安装要求及旧系统的其他步骤以 [Microsoft WSL 官方安装说明](https://learn.microsoft.com/en-us/windows/wsl/install) 为准。Windows 10 是否适合联网部署还取决于它是否处于有效安全支持范围，不只看能否安装 WSL。

**步骤 2：进入 Ubuntu 后按第 5、7 章安装。**

- 命令提示符应在 Linux 中，此后使用 Bash 命令，不把 `sudo apt` 直接粘到 PowerShell。
- 项目建议放在 WSL Linux 文件系统内，如 `/opt/server-harbor`，不要把 Windows 的 `node_modules` 复制进来。
- MySQL 也安装在同一 WSL 环境，socket 使用该环境查询到的路径。
- Mac 钥匙串不可用，仍需要第 7 章的外部秘密管理器。

**步骤 3：确认 systemd。**

在 Ubuntu 中执行 `systemctl status`。如果没有启用 systemd，按照 [Microsoft 官方 systemd 说明](https://learn.microsoft.com/en-us/windows/wsl/systemd) 编辑 `/etc/wsl.conf`，保留原有其他配置并加入：

```ini
[boot]
systemd=true
```

回到 PowerShell 执行 `wsl --shutdown`，这会停止正在运行的 WSL 工作负载，操作前保存其他任务；重新进入 Ubuntu，再配置第 7 章的服务。

**步骤 4：本机浏览器访问。**

在 Windows 浏览器尝试 `http://127.0.0.1:4317`。如果无法访问，先在 WSL 内 `curl` 健康接口，再检查 WSL localhost 转发。不要为排错直接把开发模式改为 `0.0.0.0`。

WSL 停止、Windows 睡眠或重启都会影响应用。`systemctl enable` 不代表 Windows 从未登录状态会自动拉起 WSL。长期公网服务建议 Linux 主机 / 虚拟机，或者另外完成经验证的 Windows 启动编排。

### 8.2 Windows 原生：有额外适配要求

1. 从 Node 官方所选 Node 22 补丁版页面下载 Windows x64/ARM64 对应安装包，安装后重开 PowerShell，核对 `node -v`、`npm -v`。
2. 按 [MySQL Windows 官方安装说明](https://dev.mysql.com/doc/refman/8.4/en/windows-installation.html) 安装 MySQL 8.4 和所需客户端，使用 Configurator 配置本地服务、强管理员密码及回环绑定。
3. 建库、专用账号和权限按第 7 章第 4 步处理；**不要执行 `npm run setup`，该命令只支持 macOS 钥匙串。**
4. 把源码放到例如 `C:\codes\server-harbor`，不要连同旧 `.env`、`.data` 或跨系统依赖一起覆盖。

```powershell
Set-Location C:\codes\server-harbor
npm ci
npm run build
Get-Service *mysql*
```

5. 准备 Windows 可直接执行的秘密读取程序，例如由可信代码编译的 `read-secret.exe`，从凭据服务 / 秘密管理器读取第 7 章定义的三个启动秘密。

**当前代码直接调用可执行文件，不自动启动 PowerShell / Bash。不要假设 `.ps1`、`.cmd`、`.bat` 或 Linux shell 脚本直接填进 `HARBOR_SECRET_PROVIDER` 就能运行。仓库目前没有这个 Windows 适配器。**

6. 创建 `.env`，只放公开配置。例如本地模式：

```dotenv
NODE_ENV=development
HOST=127.0.0.1
PORT=4317
PUBLIC_URL=http://127.0.0.1:4317
BRIDGE_PORT=4320
SSH_BIND_HOST=127.0.0.1
SSH_PUBLIC_HOST=127.0.0.1
SSH_PUBLIC_PORT=4320
MYSQL_HOST=127.0.0.1
MYSQL_PORT=3306
MYSQL_USER=server_harbor
MYSQL_DATABASE=server_harbor
HARBOR_SECRET_PROVIDER=C:/ProgramData/ServerHarbor/read-secret.exe
RECORD_SESSIONS=true
RECORDING_MAX_BYTES=33554432
```

Windows 原生不使用 Unix socket，因此不设置 `MYSQL_SOCKET_PATH`。上面的程序路径必须真实存在；它不是仓库自带文件。

7. 适配器和数据库就绪后运行：

```powershell
npm start
Invoke-RestMethod http://127.0.0.1:4317/api/health
```

8. 在浏览器创建管理员，并按第 14 章验收。文件 ACL 仅允许运行身份和管理员访问 `.data`、公开配置及适配器；启用磁盘加密。

Windows 服务自动安装、开机启动、服务身份访问秘密的适配尚未提供。不要把某条命令在 PowerShell 前台启动成功等同于已完成 Windows 服务部署。

### 8.3 Windows Server

推荐在 Hyper-V / 现有虚拟化平台建立受维护的 Ubuntu/Debian Linux 虚拟机：

1. 分配独立的系统盘 / 数据容量和稳定网络地址。
2. 安装 Linux 并完成系统更新、时间同步和系统 SSH 管理入口。
3. 把域名和允许的 80/443/2222 流量指向这台 Linux 虚拟机。
4. 按第 5、7、10 章部署，或选择第 9 章的 Docker 方式。
5. 备份 Linux 内的数据库、录制和秘密恢复资料；虚拟机快照不代替一致性数据库备份。

本项目 Linux Dockerfile 不能切到 Windows containers 模式直接使用。需要 Windows Server 原生部署时，仍需完成上一节的 Windows 秘密适配器和服务管理，不承诺当前仓库开箱可用。

<a id="s9"></a>

## 9. Docker：跨系统容器部署

### 9.1 先确认容器方案的前置条件

**现有模板不是下载后直接 `up` 就完整可用。以下事项需要先完成：**

- `deploy/secrets-provider/read-secret` 已实现，且其依赖能在应用和 MySQL 两种镜像内运行。
- 应用容器为 Debian slim 的非 root Node 用户；MySQL 镜像的用户、基础系统和依赖不同。宿主机上的 CLI、Mac 钥匙串和 Node 不会自动存在于 MySQL 容器。
- MySQL 只连接 `internal: true` 的数据库网络，默认不能访问公网秘密服务。若适配器要联网，需设计可达的秘密代理或受控出网网络；不能仅把脚本挂进去就认为能读取云秘密。
- 共享 socket 目录和 socket 权限需要在实际镜像上验证；应用用户必须能连接 MySQL，不能用 `chmod 777` 替代正确的用户 / 权限设置。
- DNS、HTTPS、80/443、网关端口、数据卷、秘密恢复方案均已准备。

缺少任何一项，先完成它再进行正式部署。目前未接入具体秘密服务，也没有 Docker 实测结论。

### 9.2 安装 Docker

**Ubuntu**：按 [Docker Ubuntu 官方安装页](https://docs.docker.com/engine/install/ubuntu/) 的 apt 仓库方式配置签名密钥和官方仓库，然后安装：

```bash
sudo apt update
sudo apt install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo systemctl enable --now docker
```

**Debian**：按 [Docker Debian 官方安装页](https://docs.docker.com/engine/install/debian/) 配置 Debian 仓库，再安装同一组软件包。不能在 Debian 的源文件里直接复制 Ubuntu 的仓库地址和发行代号。

**RHEL**：在干净且已评估容器运行时冲突的环境执行：

```bash
sudo dnf install -y dnf-plugins-core
sudo dnf config-manager --add-repo https://download.docker.com/linux/rhel/docker-ce.repo
sudo dnf install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo systemctl enable --now docker
```

按当前系统版本核对 [Docker RHEL 官方安装页](https://docs.docker.com/engine/install/rhel/)。已有 Podman 或其他容器工作负载时，不要直接照抄卸载命令。

**CentOS Stream 9/10**：在受维护版本中使用 CentOS 仓库，不把它混写成 RHEL 仓库：

```bash
sudo dnf install -y dnf-plugins-core
sudo dnf config-manager --add-repo https://download.docker.com/linux/centos/docker-ce.repo
sudo dnf install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo systemctl enable --now docker
```

具体支持范围与仓库要求见 [Docker CentOS 官方安装页](https://docs.docker.com/engine/install/centos/)。

**Fedora**：当前官方说明采用 DNF 的 `addrepo` 形式；按系统 DNF 版本核对：

```bash
sudo dnf config-manager addrepo --from-repofile https://download.docker.com/linux/fedora/docker-ce.repo
sudo dnf install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo systemctl enable --now docker
```

参考 [Docker Fedora 官方安装页](https://docs.docker.com/engine/install/fedora/)。Rocky / AlmaLinux 等衍生系统需按各自支持策略选择兼容仓库，不保证 Docker 对每个衍生版提供同等支持。

**macOS**：按 [Docker Desktop Mac 官方安装页](https://docs.docker.com/desktop/setup/install/mac-install/) 选择 Apple Silicon / Intel 安装包，启动 Desktop 并等待引擎就绪。

**Windows 10/11**：按 [Docker Desktop Windows 官方安装页](https://docs.docker.com/desktop/setup/install/windows-install/) 安装，启用 WSL2 后端和 Linux containers，等待引擎就绪。检查当前系统支持范围和企业使用许可。

统一检查：

```bash
docker version
docker compose version
```

Linux 若当前账号没有 Docker 权限，以下所有 Docker 命令前使用 `sudo`。Docker 管理权限接近宿主机管理员权限，不把无关账号随意加入 docker 组。

### 9.3 准备域名及部署配置

在项目根目录创建 `.env.production`：

```dotenv
APP_DOMAIN=ops.example.com
SSH_PUBLIC_PORT=2222
RECORDING_MAX_BYTES=33554432
```

将域名替换成自己拥有、已解析到部署主机的真实域名，不带协议、路径或末尾斜杠。A/AAAA 都应指向可达的正确地址。确保 80/443 未被其他程序占用。

这份 `.env.production` 是 **Compose 参数文件**。Compose 会据此设置应用容器的环境；它不同于原生 Node 默认读取的 `.env`。不要把它复制进容器当作密码文件。

Mac 可选执行：

```bash
npm run prepare:deploy -- ops.example.com
```

但必须理解它的实际行为：

- 只支持 Mac 钥匙串，生成公开 `.env.production`，部署秘密写进新钥匙串条目，终端只显示引用。
- 已有 `.env.production` 会拒绝覆盖。
- 如当前项目已配置 `VAULT_KEY`，会沿用该值；这适合迁移，**不等于每个独立生产环境都会生成新主密钥**。
- 它不会把秘密同步到 Linux，不创建云 Secret Manager，不生成容器读取适配器，也不自动恢复数据库。
- 不要误用新生成的应用数据库密码连接已存在的数据库账户；现有数据库不会随配置文件自动改密码。

完全独立的新生产系统应使用独立秘密空间、数据库和主密钥；不要为追求命令一致而无意复用旧环境主密钥。

### 9.4 放置并验收秘密读取适配器

实际挂载源目录是 **项目根目录下的 `deploy/secrets-provider/`**，不是根目录 `secrets-provider/`：

```text
server-harbor/
  deploy/
    compose.yaml
    secrets-provider/
      read-secret
      适配器需要的非秘密依赖或配置
```

1. 将已审核的适配器放入该目录，授予必要的执行 / 读取权限。
2. 不能在该目录放明文 root 密码、应用密码或主密钥。
3. 若需要额外 SDK/CLI，在相应 Dockerfile 中安装并固定兼容版本；不能假设宿主机安装后容器就可用。
4. 应用身份按接口读取应用密码、主密钥和初始化令牌；数据库初始化身份另需 root / 应用数据库密码。尽可能分离不同身份可读取的秘密范围。
5. 处理 MySQL 容器的秘密服务可达性。增加出网网络时不发布数据库端口，并限制对秘密服务的访问范围。
6. 在两个容器的实际用户身份下做“可读但不输出秘密”的预检，确认只输出检查结果、失败会退出。

**没有适配器时预期会启动失败，属于主动阻止回退到明文配置。不要把 `echo 实际密码` 写进脚本作为修复。**

### 9.5 检查配置、构建、启动

以下命令全部在项目根目录执行，且仅在前置条件已完成后继续：

```bash
docker compose --env-file .env.production -f deploy/compose.yaml config --quiet
docker compose --env-file .env.production -f deploy/compose.yaml build --pull
docker compose --env-file .env.production -f deploy/compose.yaml up -d
docker compose --env-file .env.production -f deploy/compose.yaml ps
docker compose --env-file .env.production -f deploy/compose.yaml logs --tail=100 mysql app caddy
```

`config --quiet` 只做配置校验，不验证秘密可读、镜像内依赖或外网连通性。日志应只有状态 / 错误摘要；不要把未经检查的完整日志直接发到公共渠道。

模板首次对空卷初始化 MySQL 并创建库 / 账户，应用首次运行创建业务表。**已有 MySQL 数据卷时，修改秘密管理器里的密码不会自动修改 MySQL 内的账户密码。** 需要受控地修改数据库账户与秘密版本，并协调重启。

### 9.6 确认端口与持久化

模板对宿主发布 80、443、2222；MySQL 关闭 TCP，仅通过共享 socket；4317 不对宿主发布。

```bash
curl --fail https://ops.example.com/api/health
```

预期证书有效并返回 `{"ok":true}`，不使用 `curl -k`。

持久化卷包括：

| 卷逻辑名称 | 内容 |
| --- | --- |
| `mysql_data` | MySQL 数据文件 |
| `harbor_data` | 网关加密主机密钥、录制和其他应用数据 |
| `mysql_socket` | 运行时通信路径，不是备份资料 |
| `caddy_data` / `caddy_config` | 证书等 Caddy 状态 |

Compose 项目名固定为 `server-harbor`，实际卷名以 `docker volume ls` 为准。不要在另一目录启动同名项目却误认为是完全隔离的新实例；独立环境应有独立项目名、端口、卷、域名和秘密空间。

数据库网络是 internal 网络；Web 网络固定 `172.30.43.0/24`，Caddy 地址 `172.30.43.2`。网段冲突时同步修改子网、Caddy 固定 IP、`TRUST_PROXY`，不能只改其中一个。

当前生产镜像没有打包 `mysqldump` 和完整备份脚本。不能直接声称 `docker compose exec app npm run backup` 可用；需要另做专用备份任务 / 镜像，并复用受保护的秘密读取与备份加密流程。

<a id="s10"></a>

## 10. 公网 HTTPS、反向代理与防火墙

### 10.1 Linux 原生生产配置

先停止预览实例，修改原生部署的 `.env`。下面假设 Caddy 与 Node 同机，SSH 网关直接监听 2222：

```dotenv
NODE_ENV=production
HOST=127.0.0.1
PORT=4317
PUBLIC_URL=https://ops.example.com
TRUST_PROXY=loopback
BRIDGE_PORT=2222
SSH_BIND_HOST=0.0.0.0
SSH_PUBLIC_HOST=ops.example.com
SSH_PUBLIC_PORT=2222
MYSQL_SOCKET_PATH=/run/mysqld/mysqld.sock
MYSQL_USER=server_harbor
MYSQL_DATABASE=server_harbor
HARBOR_SECRET_PROVIDER=/opt/server-harbor-secrets/read-secret
RECORD_SESSIONS=true
RECORDING_MAX_BYTES=33554432
```

替换真实域名、socket 路径和适配器路径。保留秘密管理器中同一主密钥。不要在生产配置中添加密码值。

`BRIDGE_PORT` 是实际监听端口；`SSH_PUBLIC_PORT` 是给客户端的外部端口。原生无端口映射时二者一致，Docker 则是 4320 映射至外部 2222。

`TRUST_PROXY=loopback` 仅适用于可信同机代理；同机其他恶意进程也可能伪造代理头，因此主机本身必须可信。代理不在本机时填写明确可信的代理 IP/CIDR，不能用 `true` 或按跳数放宽。

### 10.2 安装并配置 Caddy

1. 按 [Caddy 官方安装说明](https://caddyserver.com/docs/install) 为发行版安装 Caddy，优先使用其维护的服务包。
2. 域名解析指向此服务器，外部可访问 80/443，主机可以访问证书服务。
3. 在 `/etc/caddy/Caddyfile` 写入以下内容：

```caddyfile
ops.example.com {
    encode zstd gzip
    reverse_proxy 127.0.0.1:4317 {
        header_up X-Forwarded-For {remote_host}
        header_up X-Forwarded-Proto {scheme}
    }
}
```

4. 校验配置并启动：

```bash
sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
sudo systemctl enable --now caddy
sudo systemctl reload caddy
sudo systemctl restart server-harbor
```

5. 打开 `https://自己的域名`，证书正常后再输入账号密码。

Caddy 会按符合条件的域名自动申请、续期证书并重定向 HTTP；证书签发仍依赖正确 DNS、网络与端口，不是只写个域名就保证成功。[Caddy 自动 HTTPS 说明](https://caddyserver.com/docs/automatic-https)

生产模式直接访问 `http://IP:4317`、错误 Host 或未经信任代理的伪造 HTTPS 头会被拒绝，这是预期行为。域名根路径部署是当前设计，不配置 `https://域名/harbor` 子路径。

Docker 已有 Caddy 服务与反向代理配置，不再额外启动占用 80/443 的宿主 Caddy。

### 10.3 配置防火墙与安全组

先确认自己正在使用的系统 SSH 管理端口和来源网段，保留这个入口。新服务器可以按实际情况配置 UFW / firewalld；以下仅演示应用端口规则，不自动启用防火墙，也不覆盖原规则：

```bash
# Ubuntu/UFW：团队管理网段替换为真实允许来源。
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw allow from 团队公网CIDR to any port 2222 proto tcp
sudo ufw status verbose
```

RHEL 系可在确认正确 zone 后使用：

```bash
sudo firewall-cmd --get-active-zones
sudo firewall-cmd --permanent --add-service=http
sudo firewall-cmd --permanent --add-service=https
```

2222 按团队来源设置对应 zone 的来源限制规则，确认系统管理 SSH 仍可访问后再加载规则。云平台安全组也要配置，单改系统防火墙并不够。

不要对外开放 3306、4317、5173。Docker 发布端口可能绕过 UFW 的常规 INPUT 规则，还要按 Docker 的转发链策略和云防火墙限制来源，不能只看到 UFW 显示拒绝就认为容器端口不可达。[Docker 防火墙注意事项](https://docs.docker.com/engine/install/ubuntu/)

部署主机还需要出站访问：目标服务器的 SSH 端口、云安全组 API、秘密服务、DNS、时间同步及证书服务。按实际目标收紧，避免误封后以关闭校验来排错。

如果域名经 CDN / HTTP 代理，确认 2222 端口仍能到达真实 SSH 网关。普通 HTTP CDN 不会自动转发任意 SSH TCP 端口；可为网关设置单独可直达域名，并同步更新 `SSH_PUBLIC_HOST` 与客户端指纹核对流程。

<a id="s11"></a>

## 11. 远程 / 云 MySQL 的 TLS 连接

### 步骤 1：准备数据库

让 DBA 创建独立库、专用账户和所需权限，把访问来源限制为应用服务器内网地址 / 安全组。不要用 root 作运行账号。取得数据库服务的**真实主机名**和可信 CA 链。

### 步骤 2：修改公开配置

删除或清空 `MYSQL_SOCKET_PATH`，否则应用仍优先尝试 socket。使用：

```dotenv
MYSQL_HOST=db.internal.example.com
MYSQL_PORT=3306
MYSQL_USER=server_harbor
MYSQL_DATABASE=server_harbor
MYSQL_TLS=true
MYSQL_SSL_CA_FILE=/etc/server-harbor/mysql-ca.pem
```

CA 公共证书不是密码，可按受控文件分发；保证真实 CA 来源、权限和证书轮换流程。证书被系统信任时可以按实际 CA 配置评估是否省略自定义文件。

### 步骤 3：校验身份和加密

应用启用 `rejectUnauthorized: true` 和主机身份验证。数据库证书必须包含 `MYSQL_HOST` 对应身份；不要随意把域名改为不在证书中的 IP。

使用 MySQL 客户端另行验证：

```bash
mysql --host=db.internal.example.com --port=3306 \
  --user=server_harbor --password \
  --ssl-mode=VERIFY_IDENTITY --ssl-ca=/etc/server-harbor/mysql-ca.pem
```

交互输入应用数据库密码，登录后执行：

```sql
SHOW SESSION STATUS LIKE 'Ssl_cipher';
EXIT;
```

应有非空 TLS cipher，证书链与主机名校验也必须成功。`VERIFY_IDENTITY` 与仅“连接成功”不同，远程连接不能把“有加密”当作“确认了对方是谁”。[MySQL 加密连接与身份校验](https://dev.mysql.com/doc/refman/8.4/en/using-encrypted-connections.html)

### 步骤 4：重启应用并检查

重启当前受管理的应用实例，通过 HTTPS 健康接口验证数据库可用。远程主机未设置 `MYSQL_TLS=true` 会被当前程序拒绝。

不要使用 `NODE_TLS_REJECT_UNAUTHORIZED=0`、跳过证书校验、`curl -k` 或随便信任任意 CA 作为正式解决办法。

**当前备份限制：** `npm run backup` 的 mysqldump 调用尚未传入远程 TLS / CA 参数。即使应用本身开启 TLS，也不能据此认定该备份命令走相同的已验证 TLS。远程库先使用数据库服务的加密备份能力，或由 DBA 在数据库本机备份；完善并验证专用备份流程后再自动化。

<a id="s12"></a>

## 12. 旧环境迁移到新环境

### 12.1 必须一起保留的资料

| 资料 | 是否必要 | 原因 |
| --- | --- | --- |
| 一致性的数据库备份 | 必须 | 用户、服务器、加密凭据、权限、审计及录制索引在其中 |
| 原 `VAULT_KEY` 的安全恢复途径 | 必须 | 解密凭据、录制、网关私钥和应用加密备份 |
| `.data/bridge-host-key.enc` | 应保留 | 保持 SSH 网关身份，避免客户端看到无预期指纹变化 |
| `.data/recordings/` | 需要历史回放时必须 | 数据库只有索引，不含完整录制文件 |
| 公开配置与版本信息 | 必须记录 | 便于恢复一致的域名、端口、数据库设置及程序版本 |
| 当前数据库账号密码 | 可重新开户替换 | 不等于主密钥，可以按新环境重新配置 |

不复制 `node_modules`、socket 文件或旧主机的进程状态。新机器的 Mac 钥匙串引用本身不能代替秘密迁移。

### 12.2 按这个顺序迁移

1. 确认旧主密钥能够通过受保护方式导入目标秘密管理器；先验证恢复能力，再安排停机。
2. 在新机器安装系统依赖、放入相同版本源码，运行 `npm ci` 和 `npm run build`，**暂不启动应用**。
3. 暂停旧系统的写入和 SSH 会话，在维护窗口停止旧应用，保证数据库和录制文件来自同一一致状态。
4. 生成数据库加密备份，复制加密备份及完整应用数据资料；记录备份时间、文件大小与校验值。
5. 在目标建立新的数据库与运行账户；设置合适的恢复账户，按第 13 章恢复。不要把恢复所需的额外权限永久留给运行账号。
6. 将**原主密钥**写入目标秘密管理器。目标应用数据库密码与新数据库账户对应；初始化令牌独立生成并保管。
7. 恢复 `.data/bridge-host-key.enc` 和录制目录，授予目标运行用户正确权限。
8. 写入目标主机的公开配置，确认 socket / TLS、秘密适配器、生产域名与代理可信地址。
9. 启动目标应用，核对用户、服务器数量、旧凭据可用、历史录制可播放、网关指纹正确。
10. 原系统保持停止，再切 DNS / 流量。确认通过后按保留计划处理旧机器和旧访问权限。

不要让两台未经设计的应用同时对同一个数据库提供服务。当前启动逻辑会把未完成连接标记为结束，活动 SSH 状态也在单实例内存中，不支持随意双活。

迁移到另一台 Mac 时，默认 `setup` 会生成新主密钥并拒绝同名库。不要为了迁移删除数据库重跑。目标 Mac 的钥匙串秘密应通过受保护导入流程建立，或改用已接好的外部秘密适配器；**仓库尚无跨 Mac 自动导入 / 导出命令**。

### 12.3 这些操作不能当作密钥轮换

- 修改 `.env` 中某个字符串。
- 删除钥匙串条目后重新运行 setup。
- 重新执行随机密钥生成，再尝试打开旧凭据。

当前没有完成“全部旧数据重新加密”的主密钥轮换工具。如果需要轮换，必须另做受控的数据重加密、恢复验证和回滚方案。

<a id="s13"></a>

## 13. 备份、恢复与密钥保管

### 13.1 本机 socket 数据库备份

在当前原生部署项目根目录执行，保证 `mysqldump` 在 PATH 中，并使用可读取秘密的运行身份：

```bash
mysqldump --version
npm run backup
```

脚本使用单事务导出，SQL 直接经管道 AES-256-GCM 加密，写到 `.data/backups/harbor-时间.sql.enc`，不创建明文 SQL 中间文件。数据库密码只交给子进程运行时环境，不放在命令参数中；因此要限制同机进程检查、调试与转储权限。

该文件是**应用自定义加密格式**，不是普通 SQL，也不是标准 `openssl enc` 文件。不要执行 `mysql < xxx.sql.enc`，也不要直接照搬网上的 OpenSSL 解密命令。

远程数据库与 Docker 的备份限制见第 9、11 章。定时任务只有在服务身份能读取秘密、PATH 正确、失败可告警、结果可恢复时才算配置完成。

### 13.2 完整备份还要包含什么

1. 加密数据库备份。
2. 网关加密主机密钥和完整加密录制目录。
3. 对应程序版本和非秘密配置。
4. **与上述数据分开保管**的主密钥恢复途径，例如访问受控的秘密管理器版本备份 / 灾备恢复。
5. Caddy 状态可按运营需求备份；证书服务恢复不能代替应用数据恢复。

停止应用后可以归档加密应用数据；例如在项目根目录：

```bash
tar -czf /受保护备份目录/harbor-appdata.tar.gz \
  .data/bridge-host-key.enc .data/recordings
```

示例目录必须改为真实、访问受限的备份位置。此归档封装的是已加密文件，归档本身没有再做一层加密，文件名和目录元数据可见；需要隐藏这些元数据时，再使用组织批准的加密备份系统。

不要把整个在线 MySQL 数据目录随便复制一份就当作可恢复备份，也不要把主密钥明文塞进同一个备份包。

### 13.3 恢复流程

**当前仓库没有一键恢复脚本，不能把加密备份直接当 SQL 导入。** 恢复应先在隔离的新数据库演练：

1. 建立空的目标库和临时恢复账户；不要直接覆盖当前业务库。
2. 让恢复进程能从受保护的秘密管理器取得原主密钥和恢复数据库凭据。
3. 由受控恢复工具调用 `server/backup-crypto.mjs` 的 `readBackup(file, key)` 验证并在内存中解密，再把结果通过进程管道写入 MySQL 客户端 / 经过审核的导入流程，不落盘明文 SQL。
4. mysqldump 默认输出可能包含 `DROP TABLE` 等语句，普通运行账号没有这些权限。使用仅限目标恢复库的临时恢复权限，恢复后撤销；不要给运行账号全局 root 权限。
5. 当前 `readBackup` 会将备份读入内存，大备份需规划内存或另做验证过的流式恢复工具，不能假设任意大小都能恢复。
6. 恢复对应录制和网关密钥，配置同一主密钥，启动隔离环境验证。
7. 验证通过后才按迁移 / 回滚窗口切换业务。

上述恢复工具尚需按具体部署环境准备和审查。本文不会提供一个把秘密打印到终端或生成临时明文 SQL 的“便捷恢复”命令。

### 13.4 怎样判断备份真的可用

- 新库能完成恢复，用户和服务器数据符合预期。
- 用原密钥能够解密一条已知服务器凭据，且在授权条件下完成连接。
- 历史录制通过完整性校验并可回放。
- 网关指纹与迁移前一致。
- 备份故意使用错误密钥或被改动时，恢复应失败。

至少定期做恢复演练；“生成了文件”只证明有输出，不证明能灾难恢复。

<a id="s14"></a>

## 14. 首次登录与功能配置

### 步骤 1：创建管理员

本地模式在 `http://127.0.0.1:4317` 创建；公网必须在证书有效的 HTTPS 页面创建。公网首次还需输入秘密管理器中的 `BOOTSTRAP_TOKEN`，不要把令牌写进浏览器地址、截图、聊天或部署说明。

如果恢复了旧数据库，直接使用原账号登录，不重新创建管理员。令牌不会把一个已有系统重置为空系统。

保留至少两个可信管理员更便于应对单个管理员被登录锁定；每位管理员独立账号，不共享同一登录密码。

### 步骤 2：创建成员和权限

在“成员与权限”创建成员，按需要授权新增 / 修改 / 删除 / SSH 与监控 / 安全组管理。普通成员的查看和连接默认权限要在创建时复核，不能只以自己期望的角色名称判断实际权限。

连续 5 次登录失败会锁到次日北京时间 00:00，管理员可以在成员列表点击“解除登录锁定”。管理员手动停用和登录失败锁定是两种状态，解除登录锁定不会自动启用被停用账号。

### 步骤 3：添加服务器并核对指纹

填写服务器名称、真实 SSH 地址、端口、账号，选择密码或私钥认证，保存。密码或私钥会在服务端加密保存，不会为了编辑回传原值。

首次信任目标主机指纹前，通过云控制台 / 独立可信管理通道核对。可以在目标服务器可信控制台查看相应公钥指纹，例如：

```bash
ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub -E sha256
```

实际使用的密钥算法以目标 SSH 服务与客户端协商结果为准。仅从可能已被劫持的同一路径运行 `ssh-keyscan` 并点信任，不构成独立核对。

### 步骤 4：验证网页 SSH 与 Termius

1. 在网页中打开“网页 SSH”，输入无破坏性的查看命令，例如 `whoami`，确认连接和断开正常。
2. 关闭终端窗口应断开相应连接，操作进入审计，录制可以由管理员回放。
3. 使用者自己的电脑先安装并允许 Termius 的 URL 协议打开。
4. 点击 Termius，连接的是本项目网关，真实目标密码 / 私钥不会被写进 URL。
5. 临时票据 90 秒过期且只能使用一次，过期后从页面重新点击，不反复使用旧链接。
6. Termius 首次连接网关也要核对网关指纹；网关与目标服务器是两套不同主机身份。

当前不提供 SFTP、端口转发或 SSH Agent 转发。不能把这些功能连接失败误判为 SSH 密码错误。

### 步骤 5：监控、安全组与日志

- 点击 Linux 服务器的监控入口，查看 CPU、内存、磁盘；默认每 5 秒采样，依赖该账号 SSH 权限与目标系统命令可用。
- 云安全组目前有腾讯云、阿里云、华为云、AWS 官方 SDK 适配；不是任意厂商都已接通。
- 云 API Secret 在“云账号与密钥”维护，部署启动秘密则在系统钥匙串 / 外部秘密管理器维护，两者入口不同。
- 安全组先确认关联实例、区域和规则范围。安全组可能被多台机器共用；不要为测试随意开放 `0.0.0.0/0` 的管理端口。
- 管理日志中核对操作账号、服务器和动作；管理员可查看会话录制，普通成员不应能读取他人记录。

云适配器尚未使用真实云凭据完成各厂商联调。正式操作真实规则前先对隔离的测试安全组验收，并保留独立云控制台管理入口。

<a id="s15"></a>

## 15. 启动、停止、更新与回滚

### 15.1 常用操作

| 环境 | 启动 | 停止 / 重启 |
| --- | --- | --- |
| 本地前台 | 项目根目录 `npm start` | 当前终端 `Ctrl+C`；重新启动 |
| IDE | npm `start` 配置 | 先停止旧实例，再启动 |
| Linux 服务 | `sudo systemctl start server-harbor` | `stop` / `restart server-harbor` |
| Docker | 见第 9 章 `up -d` | 使用同一 env 和 compose 文件执行 `stop` / `restart` / `down` |

Docker 安全停止例子：

```bash
docker compose --env-file .env.production -f deploy/compose.yaml stop
docker compose --env-file .env.production -f deploy/compose.yaml start
```

`down` 默认保留命名数据卷。**不要执行 `down -v` 或卷清理命令来解决启动错误，这会删除数据库 / 录制等持久化资料。**

### 15.2 更新步骤

1. 记录现有版本、配置、秘密版本引用和网关指纹，确认备份可恢复。
2. 安排维护窗口并停止当前应用，活动 SSH 会话会断开。
3. 更新源码，保留原公开配置、原 `.data` 和同一主密钥，不用新源码包里的任何示例覆盖它们。
4. 原生运行 `npm ci`、`npm run build`；容器使用同一 Compose 参数重建镜像。
5. 重启后检查 HTTPS 健康接口、登录、连接、历史回放和权限。
6. 发现失败则停止新版本，按记录恢复上一套程序与其匹配的数据 / 配置。涉及数据结构或数据内容变更时不能只回退代码。

更新不是再次运行 setup。`prepare:deploy` 也不是升级数据库密码或主密钥的命令。

<a id="s16"></a>

## 16. 常见错误逐项处理

### 16.1 `EADDRINUSE`

含义：4317、4320 或改过的网关端口已有进程监听，常见原因是终端、IDE、systemd 又启动了同一项目。

macOS：

```bash
lsof -nP -iTCP:4317 -sTCP:LISTEN
lsof -nP -iTCP:4320 -sTCP:LISTEN
```

Linux：

```bash
sudo ss -ltnp
sudo systemctl status server-harbor --no-pager
```

Windows PowerShell：

```powershell
Get-NetTCPConnection -State Listen | Where-Object { $_.LocalPort -in 4317,4320,2222 }
```

先识别进程属于谁，从原启动入口正常停止；不要不看进程就 `kill -9`。如果确定必须换端口，公开 URL、网关内外端口、代理和防火墙一并修改。

### 16.2 setup 显示“配置文件已存在，未作修改”

脚本只检查 `.env` 是否存在，不判断数据库是否完成初始化。全新安装不要预先创建 `.env`；已有环境不要删配置来强行重跑。

先确认文件是不是自己新建的空壳，确认是否已生成数据库 / 用户 / 钥匙串条目。只有确定没有旧数据和秘密需要保留时才调整空壳配置；旧环境走迁移流程。

### 16.3 “同名数据库或用户已存在”

即使数据库为空、同名用户只存在其他 Host，Mac setup 也会停止。它不会接管或覆盖既有数据库。确认是旧环境、DBA 预建库还是上次部分失败，然后完成手工配置；不要把 `DROP DATABASE` 当作默认修复。

### 16.4 `ECONNREFUSED` / `ENOENT` / socket 不存在

- 先查 MySQL 服务是否运行。
- 从正确 MySQL 实例执行 `SELECT @@socket;`，核对 `.env` 路径。
- 不手工创建 socket，不从旧主机复制它。
- Docker 查 `mysql` 健康状态、共享卷和权限；原生 systemd 查 `PrivateTmp` 是否隔离了 `/tmp` socket。
- `MYSQL_SOCKET_PATH` 非空时优先使用 socket，单独改 `MYSQL_HOST` 不会切到远程库。

### 16.5 `Access denied` / `ER_ACCESS_DENIED_ERROR`

检查数据库用户的 Host 匹配、密码是否与秘密管理器一致、是否连接错实例。`localhost` 与 `127.0.0.1` 可能匹配不同账户，容器访问来源又不同。

不要把应用用户临时改成 root。已有 Docker 数据卷不会因改了环境中的初始化密码而自动更新数据库用户。

### 16.6 无法读钥匙串 / 秘密管理器

检查运行用户、钥匙串是否解锁、Node 路径权限、引用是否来自另一台 Mac。Linux / Windows 移除无效 Mac 引用，检查真实适配器绝对路径、执行权限、运行身份、CA、超时和网络。

`无法从外部秘密管理器读取 BOOTSTRAP_TOKEN` 在本地模式也可能出现，因为配置适配器后每次都读取它。不要靠空脚本或输出 JSON 来绕过。

### 16.7 `VAULT_KEY` 格式错误 / 旧密码不能解密

确认是 64 位十六进制原始字符串，不是带字段名的 JSON、Base64、额外引号或换行。迁移时核对是否错误生成了新主密钥；只有原密钥能恢复旧密文。

主密钥丢失不能通过重置网页登录密码找回。先停止写入并恢复正确秘密版本，不继续用错误密钥覆盖资料。

### 16.8 浏览器 403、登录后马上失效、WebSocket 失败

核对访问域名与 `PUBLIC_URL` 完全对应、HTTPS 证书有效、Caddy 正确覆盖代理头、`TRUST_PROXY` 仅指向真实代理、没有反向代理子路径。

生产 Secure Cookie 不应通过 HTTP 使用。不要通过取消 Secure、放开 Origin、关闭 Host 检查或信任任意代理“修复”。

### 16.9 Caddy 证书申请失败

检查 A/AAAA、80/443 的外部可达性、是否被其他服务占用、CDN 模式、系统时间、DNS 传播与证书签发限制。不要反复重建生产证书卷；排查时保留已签发证书状态。

### 16.10 SSH 指纹变化 / Termius 连接失败

目标指纹变化先通过独立管理通道核实；网关指纹变化检查 `.data/bridge-host-key.enc` 是否被丢弃、换密钥或误用新卷。未经核实不批量接受新指纹。

另外检查 Termius 是否安装、协议唤起权限、网关域名与端口可达、90 秒票据是否过期；网页 SSH 可用而 Termius 不可用时，尤其检查独立 SSH TCP 端口和 CDN 转发。

### 16.11 登录锁定

第 5 次连续错误会锁到北京时间次日 00:00，正确密码也不能提前登录。让另一管理员在“成员与权限”解除登录锁定，或等待自动到期。不要改系统时间、删表或直接删除数据库记录绕过。

如果所有管理员都被锁，当前未提供离线解锁命令，需要等待到期；手动停用又是独立状态。提前安排第二名可信管理员和恢复流程。

<a id="s17"></a>

## 17. 部署验收与安全边界

### 17.1 基础验收

- [ ] 系统和 Node 仍在安全支持范围，版本与项目要求相符。
- [ ] 本机 `npm run build` 成功，或容器镜像构建成功；没有跨系统复用依赖。
- [ ] 只有预期的一套实例占用端口，重启后配置和数据仍在。
- [ ] 健康接口返回 `{"ok":true}`；公网必须是证书校验通过的 HTTPS。
- [ ] MySQL 不暴露公网；远程数据库验证 TLS 证书与主机身份。
- [ ] 专用账户权限限于本库，应用不使用 root。
- [ ] `.env`、Compose、服务文件、源码、日志、进程命令参数没有真实密码或主密钥。
- [ ] 秘密读取失败时启动失败，不存在明文文件回退。
- [ ] 网页 SSH、Termius、目标指纹核对和连接断开行为符合预期。
- [ ] 管理动作日志包含账号、服务器、动作；录制及回放通过完整性检查。
- [ ] 以普通成员验证新增 / 修改 / 删除 / 云权限，没有授权就应拒绝。
- [ ] 主密钥异机恢复资料齐全，已在隔离环境做过备份恢复演练。

### 17.2 登录和网络安全检查

只对自己授权的隔离测试环境做失败登录测试，使用专门测试成员，不拿唯一管理员试锁定：

1. 正常登录后退出，旧会话和该账号 SSH 连接应失效。
2. 测试账号连续输错 5 次，应锁定到次日北京时间 00:00；正确密码此时也不能登录。
3. 另一管理员解锁该测试账号，允许重新登录，并生成解锁审计。
4. 不接受浏览器证书警告；证书错误必须先修正，不能继续提交凭据。
5. 授权抓包检查时，仅针对测试账号 / 测试流量；正常 HTTPS/WSS/TLS/SSH 抓包不应直接读到密码或 Cookie，证书校验失败应中止连接。

若本机安装了可拦截 HTTPS 的企业根证书、代理软件，或者客户端 / 服务主机已被控制，单纯“网络包看不到明文”不能证明账号绝不会泄露。本项目也未提供正式第三方渗透测试认证。

### 17.3 自动化测试注意事项

普通单元测试：

```bash
npm test
```

集成、安全和锁定测试必须使用独立的 `server_harbor_test` 数据库及专用配置，不连接生产库。Mac 可用：

```bash
npm run setup -- --test
npm run test:integration
npm run test:security
npm run test:lockout
```

Linux / Windows 没有同等的自动测试库初始化器，需要另外准备符合测试配置读取方式的秘密和专用库。不把这些命令原样接入生产启动流程。

已有安全测试使用隔离模拟服务，不能替代新环境的 DNS、代理、秘密服务、真实云 API 和容器权限验收。更详细的既有检查范围见 [SECURITY-REVIEW.md](SECURITY-REVIEW.md)。

### 17.4 当前功能限制

- 未完成所有系统的真实部署验收，本文命令需要按系统版本和组织环境核对。
- Linux / Windows / Docker 的秘密管理器适配器、非 Mac 安全开户和受控恢复工具需要另外准备。
- 原生 Windows 没有服务安装器；Docker 的秘密读取依赖、数据库秘密服务可达性和备份任务需要实际集成。
- 当前单实例运行；重启断开 SSH；不支持直接加副本实现无缝切换。
- 目前没有账号 MFA、录制自动保留清理、已完成的主密钥轮换或不可变外部审计存储。
- 本系统只记录经自己网关的会话，绕过平台直连目标的操作不会自动记录。
- 终端输入 / 输出录制不是目标主机上的进程级命令审计；隐藏输入可能出现在管理员回放中，但存储本身经过加密。

<a id="s18"></a>

## 18. 配置速查与命令速查

### 18.1 公开配置

| 参数 | 含义 / 注意事项 |
| --- | --- |
| `NODE_ENV` | 原生公网必须为 `production`；默认本地模式 |
| `HOST`、`PORT` | HTTP 监听地址和端口；本地强制回环 |
| `PUBLIC_URL` | 用户访问的完整 origin；公网 https，无子路径、账号、查询参数 |
| `TRUST_PROXY` | 明确信任的代理 IP/CIDR 或同机 loopback，禁止 true / 跳数 |
| `BRIDGE_PORT` | 网关真实监听端口，默认 4320 |
| `SSH_BIND_HOST` | 网关监听地址；本地强制回环 |
| `SSH_PUBLIC_HOST`、`SSH_PUBLIC_PORT` | Termius 使用的可访问网关域名和外部端口 |
| `MYSQL_SOCKET_PATH` | 本机 / 共享 socket；非空时优先于 TCP |
| `MYSQL_HOST`、`MYSQL_PORT` | TCP 数据库地址；不要带协议 |
| `MYSQL_USER`、`MYSQL_DATABASE` | 运行账号与库名 |
| `MYSQL_TLS` | 远程 MySQL 必须为字符串 `true` |
| `MYSQL_SSL_CA_FILE` | 可信数据库 CA 公共证书路径 |
| `HARBOR_KEYCHAIN_ACCOUNT` | Mac 当前用户钥匙串秘密条目引用 |
| `HARBOR_SECRET_PROVIDER` | 外部秘密读取可执行程序绝对路径 |
| `RECORD_SESSIONS` | 默认录制；按当前审计要求保持 `true` |
| `RECORDING_MAX_BYTES` | 单次录制限制，默认 33554432；达到上限会结束会话 |
| `DOTENV_CONFIG_PATH` | Node 显式选择公开配置文件路径；默认读取当前工作目录 `.env` |
| `APP_DOMAIN` | 仅 Compose / 相关部署准备使用的域名参数 |

原生 Node 不会因为设置了 `NODE_ENV=production` 就自动改读 `.env.production`。默认仍是当前工作目录 `.env`；需要指定其他文件时使用非秘密的 `DOTENV_CONFIG_PATH`。Compose 的 `--env-file .env.production` 则由 Compose 读取，两者不要混淆。

### 18.2 最短顺序

**新 Mac，本地全新库：**

```text
安装 Node 22 + MySQL 8.4 → 启动 MySQL → 放入源码 → npm ci
→ 不预建 .env → npm run setup → npm run build → npm start
→ http://127.0.0.1:4317 → 创建管理员 → 配置成员与服务器
```

**Linux 原生：**

```text
安装 Node/MySQL → 运行身份与源码 → npm ci/build
→ 秘密管理器生成/导入秘密 → 适配器与工作负载身份
→ DBA 建库开户并同步密码 → 公开 .env → 不输出秘密的预检
→ HTTPS/网关/防火墙 → systemd 启动 → 创建管理员 → 验收和恢复演练
```

**Docker：**

```text
Docker + Compose → 域名/DNS → 公开 .env.production
→ 秘密管理器/适配器 → 两种镜像内依赖和身份
→ MySQL 秘密服务可达性与 socket 权限 → 构建 → up
→ HTTPS 检查 → 创建管理员 → 数据卷与备份恢复验收
```

**迁移已有系统：**

```text
先确认原主密钥可恢复 → 停旧实例 → 一致性加密备份
→ 新环境恢复数据库和加密 .data → 导入原主密钥
→ 配置新数据库连接 → 启动验证 → 切换流量
```

部署记录只填写版本、域名、端口、秘密引用、备份位置、检查结果和负责人，不把实际秘密填到本文或另存成“部署记录.txt”。
