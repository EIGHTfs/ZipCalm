// 默认配置（docs/M0/数据模型.md §八 的 M1 子集）
//
// 只放 M1 真正用到的段：server / auth / storage / limits / log。
// compress（M2）、blacklist（M6）、metrics（M7）等到各自里程碑再加，避免出现"配了但没人读"的死配置。
//
// 覆盖优先级（低 → 高）：本文件默认值 → <dataDir>/config.json → 环境变量。

/** POSIX 单段文件名长度上限（NAME_MAX 的常见值）：给 maxPathSegmentLength 当默认值用 */
const POSIX_NAME_MAX = 255;
/** 单次列目录返回的默认最大条目数（超出截断并置 truncated=true） */
const DEFAULT_MAX_LIST_ENTRIES = 5000;

export const DEFAULT_CONFIG = {
  server: {
    /** 监听地址：0.0.0.0 表示所有网卡（NAS 场景方便局域网访问） */
    host: '0.0.0.0',
    port: 3010,
    trustProxy: false,
  },

  auth: {
    username: 'admin',
    /** 二选一：passwordHash 优先（推荐）；都为空则启动失败并提示生成方式 */
    password: null,
    passwordHash: null,
    /** Session（HttpOnly Cookie）有效期：7 天滑动续期（API 规范 §二） */
    sessionTtlMs: 7 * 24 * 60 * 60 * 1000,
    /** Bearer Token 有效期：30 天（API 规范 §二） */
    tokenTtlMs: 30 * 24 * 60 * 60 * 1000,
    /** 登录失败限流 */
    loginRateLimit: { max: 5, windowMs: 60 * 1000 },
    /** Cookie 名（API 规范 §二：zc_session） */
    cookieName: 'zc_session',
  },

  storage: {
    /** 可浏览/可压缩的默认存储根：单根回退，也是侧栏里的「应用数据」项 */
    root: './storage/fs-root',
    /**
     * 可切换的根列表（docs/16 §三）：[{ id, label, path }]。
     * **空数组 = 自动发现**（群晖列 /volumeN 下的共享；其他系统列卷/挂载点）。
     * 显式配置优先于自动发现；相对 path 与 root 同规则按项目根解析。
     */
    roots: [],
    /** 运行态数据目录（任务状态、令牌、日志、回收站都在这里；已 gitignore） */
    dataDir: './storage',
    trashDir: './storage/trash',
    logDir: './storage/logs',
  },

  compress: {
    /** 默认压缩格式（M2 只有 zip） */
    defaultFormat: 'zip',
    /** 默认压缩模式：single（每个源各一个包）/ bundle（合成一个包） */
    defaultMode: 'single',
    /** 默认保留原文件（删除必须显式请求 + 二次确认，docs/06 §一） */
    defaultKeepOriginal: true,
    /** zip 默认压缩级别 */
    defaultLevel: 6,
    /** 并行开关（占位：v1 强制串行，docs/05 §二） */
    parallelEnabled: false,
    /** INV-07：剩余空间必须 ≥ 待压总量 × preflightFactor（不允许 < 2） */
    preflightFactor: 2,
  },

  delete: {
    /**
     * 删除执行模式（docs/M0 数据模型 §八）：
     * - log-only（默认）：只写删除日志、**不真删** —— 开发期核对"校验通过 → 触发删除"的时机；
     * - trash：真删并进 storage/trash/<batchId>/（可恢复），正式部署用；
     * 未知值 → 告警并回落 log-only（安全默认：绝不因配置写错而真删数据）。
     */
    /**
     * 回收站后端（mode=trash 时生效）：
     * - auto（默认）：探测到群晖 `/usr/syno/bin/synorecycle` 就用系统回收站（删除进 DSM 的 #recycle，
     *   用户可在 File Station 里恢复/清空），否则用项目 storage/trash；
     * - system：强制系统回收站，不可用/失败时**回退项目 trash**（不报错、绝不真删）；
     * - project：强制项目 storage/trash；
     * - none：不启用回收站 —— 删除会被拒绝并记 failed（绝不退化成真删）。
     */
    mode: 'log-only',
    trashBackend: 'auto',
    /**
     * waiting_confirm 最长等待（数据模型 §八 / §3.3 硬要求 1）：
     * 默认 30 分钟；0 = 不超时；非法值（负数/非数字）→ 告警并回落默认。
     * 超时按放弃删除结算（delete.status='skipped'，reason=confirm_timeout）——超时绝不等于确认。
     */
    confirmTimeoutMs: 1800000,
  },

  limits: {
    /** 路径字符串长度上限（整条路径，超长直接判非法路径） */
    maxPathLength: 4096,
    /**
     * 单个路径段的长度上限（对应 POSIX NAME_MAX）。
     * 为什么不写死 255：不同文件系统（ext4/btrfs/APFS/NTFS、以及各种 FUSE/网络盘）上限不同，
     * 这里是**可配置**的：默认取 POSIX 常见值 255，部署到特殊文件系统时可调。
     * 超过即在进入磁盘调用前返回 INVALID_PATH(400)，不让底层 ENAMETOOLONG 冒成 500。
     */
    maxPathSegmentLength: POSIX_NAME_MAX,
    /** 单次列目录返回的最大条目数（超出截断并置 truncated=true） */
    maxListEntries: DEFAULT_MAX_LIST_ENTRIES,
    /** 单次压缩任务最多源条目数 */
    maxSourcesPerTask: 200,
    /**
     * 单次「移动」最多条目数（API 规范 §4.2：超限 VALIDATION_FAILED）。
     * 为什么要有上限：v1 是同步操作，一次几百个 rename 会让请求超时；超过应分批或改用复制任务。
     */
    maxMoveItems: 200,
    /** 单次「删除」最多条目数（同上，删除还要逐条走回收站，代价更高） */
    maxDeleteItems: 200,
    /** 前端默认分页大小 */
    defaultPageSize: 200,
    /**
     * 任务历史保留条数（task-history.jsonl 的裁剪上限，数据模型 §六）
     */
    taskHistoryMax: 200,
    /** SSE 环形缓冲保留的事件条数（`since` 超出窗口即改用快照兜底，API 规范 §五 规则 2） */
    sseRetention: 1000,
    /** SSE 心跳间隔（防中间设备把长连接当空闲连接掐掉） */
    sseHeartbeatMs: 15000,
    /**
     * 任务活动记录保留条数（`failed`/`interrupted` 这两类"为可重试而保留"的终态上限，
     * 数据模型 §六 规则 6）：超出即清理最旧的，避免 tasks.json 全量重写越来越慢。
     * 上限走配置、不写死；`done`/`aborted` 本来就即写即移出，不参与该计数。
     */
    taskRetentionMax: 100,
    /** 任务活动记录保留天数（与条数任一先到即清理） */
    taskRetentionDays: 7,
  },

  log: {
    level: 'info',
  },
};

/** 环境变量覆盖白名单（只允许"单值"型部署差异，结构性配置一律走 config.json） */
export const ENV_OVERRIDES = {
  ZIPCALM_HOST: ['server', 'host'],
  ZIPCALM_PORT: ['server', 'port'],
  ZIPCALM_STORAGE_ROOT: ['storage', 'root'],
  ZIPCALM_DATA_DIR: ['storage', 'dataDir'],
  ZIPCALM_LOG_LEVEL: ['log', 'level'],
  ZIPCALM_USERNAME: ['auth', 'username'],
  ZIPCALM_PASSWORD: ['auth', 'password'],
  ZIPCALM_PASSWORD_HASH: ['auth', 'passwordHash'],
};

/** 敏感字段：任何日志/响应都不允许带明文（INV-16） */
export const SENSITIVE_CONFIG_KEYS = ['password', 'passwordHash'];
