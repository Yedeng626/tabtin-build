import { is } from '@electron-toolkit/utils'
import { app } from 'electron'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export type TabTinRuntimeProfile = 'development' | 'local' | 'community' | 'preprod' | 'production'

export interface TabTinAppIdentity {
  profile: TabTinRuntimeProfile
  appId: string
  productName: string
  userDataDirName: string
}

const PROFILE_IDENTITIES: Record<TabTinRuntimeProfile, TabTinAppIdentity> = {
  development: {
    profile: 'development',
    appId: 'com.qizhikitty.app.dev',
    productName: 'QiZhiKitty Dev',
    userDataDirName: 'QiZhiKitty Dev',
  },
  local: {
    profile: 'local',
    appId: 'com.qizhikitty.app.local',
    productName: 'QiZhiKitty Local',
    userDataDirName: 'QiZhiKitty Local',
  },
  community: {
    profile: 'community',
    appId: 'com.qizhikitty.community',
    // 社区档的用户可见名就是品牌名（窗口标题 / 任务栏 / 安装目录）。
    // 注意：因此它与 production 的产品名相同，macOS Safe Storage（由 app.getName()
    // 派生 keychain service）命名空间也相同 —— 同一台机器不要同时常驻这两档；
    // userData 目录仍按档位区分，保证本地数据互不覆盖。
    productName: 'QiZhiKitty',
    userDataDirName: 'QiZhiKitty Community',
  },
  preprod: {
    profile: 'preprod',
    appId: 'com.qizhikitty.app.preprod',
    // Electron safeStorage derives its macOS Keychain service from app.getName().
    // Keep this distinct from production and aligned with the packaged app name.
    productName: 'QiZhiKitty Preprod',
    userDataDirName: 'QiZhiKitty Preprod',
  },
  production: {
    profile: 'production',
    appId: 'com.qizhikitty.app',
    productName: 'QiZhiKitty',
    userDataDirName: 'QiZhiKitty',
  },
}

function normalizeProfile(value: string | undefined): TabTinRuntimeProfile | undefined {
  const normalized = value?.trim().toLowerCase()
  if (!normalized) return undefined
  if (normalized === 'dev' || normalized === 'development') return 'development'
  if (normalized === 'local' || normalized === 'localdev') return 'local'
  if (normalized === 'community') return 'community'
  if (normalized === 'preprod' || normalized === 'preproduction') return 'preprod'
  if (normalized === 'prod' || normalized === 'production') return 'production'
  return undefined
}

function inferProfileFromText(value: string | undefined): TabTinRuntimeProfile | undefined {
  const raw = value?.trim()
  if (!raw) return undefined
  const normalized = raw.toLowerCase()
  if (normalized.includes('preprod')) return 'preprod'
  if (normalized.includes('community')) return 'community'
  if (normalized.includes('com.tabtin.app.local')) return 'local'
  if (/(^|[^a-z0-9])tabtin[^a-z0-9]+local([^a-z0-9]|$)/.test(normalized)) return 'local'
  // 社区档的发行名与正式版同名（都是 QiZhiKitty），不能拿品牌名当档位标记，
  // 只能靠**大小写敏感**的可执行名 / 路径段区分：打包脚本给社区档的
  // executableName 是全小写 `qizhikitty`，正式版沿用驼峰 `QiZhiKitty`。
  // 这一条必须排在最后，免得抢在 preprod / community 等更明确的标记之前命中。
  // （绝不能用 includes('local')：Windows 安装路径里的 AppData\Local 会误判成 local 档。）
  if (/(^|[^A-Za-z0-9])qizhikitty([^A-Za-z0-9]|$)/.test(raw)) return 'community'
  return undefined
}

function getAppPathSafely(name: Parameters<typeof app.getPath>[0]): string {
  try {
    return app.getPath(name)
  } catch {
    return ''
  }
}

function resolvePackagedRuntimeProfileFromMetadata(): TabTinRuntimeProfile | undefined {
  try {
    const packageJsonPath = join(app.getAppPath(), 'package.json')
    const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf-8')) as {
      tabtinDesktop?: { buildProfile?: string }
      build?: { extraMetadata?: { tabtinDesktop?: { buildProfile?: string } } }
    }
    return normalizeProfile(
      pkg.build?.extraMetadata?.tabtinDesktop?.buildProfile ??
        pkg.tabtinDesktop?.buildProfile,
    )
  } catch {
    return undefined
  }
}

export function resolvePackagedRuntimeProfileFromHost(): TabTinRuntimeProfile | undefined {
  const markers = [
    (() => {
      try {
        return app.getName()
      } catch {
        return ''
      }
    })(),
    process.resourcesPath,
    process.execPath,
    getAppPathSafely('exe'),
  ]

  for (const marker of markers) {
    const profile = inferProfileFromText(marker)
    if (profile) return profile
  }
  return undefined
}

export function resolveRuntimeProfile(): TabTinRuntimeProfile {
  const explicitProfile =
    normalizeProfile(process.env.TABTIN_RUNTIME_PROFILE) ??
    normalizeProfile(process.env.VITE_BUILD_PROFILE) ??
    normalizeProfile(process.env.TABTIN_BUILD_PROFILE)

  if (explicitProfile) {
    return explicitProfile
  }

  if (!app.isPackaged) {
    return 'development'
  }

  const packagedMetadataProfile = resolvePackagedRuntimeProfileFromMetadata()
  if (packagedMetadataProfile) {
    return packagedMetadataProfile
  }

  const packagedProfile = resolvePackagedRuntimeProfileFromHost()
  if (packagedProfile) {
    return packagedProfile
  }

  return 'production'
}

/**
 * 主进程统一的开发语义判断。
 *
 * local 安装包必须保留 Electron 的 packaged 语义，同时获得与开发启动
 * 一致的主进程能力；preprod / production 仍保持正式包语义。
 */
export function resolveIsDevRuntime(): boolean {
  return is.dev || !app.isPackaged || resolveRuntimeProfile() === 'local'
}

export function resolveRuntimeAppIdentity(): TabTinAppIdentity {
  return PROFILE_IDENTITIES[resolveRuntimeProfile()]
}

/**
 * 用户可见的默认 Workspace 顶层目录名。
 *
 * Workspace 的 working_dir 是用户本机的外部执行现场，不能跟着 userData
 * 藏进 Application Support；但不同安装档也不能再共用同一个工作区根。
 * 按 **userData 目录名** 分根（而不是产品名）：产品名可能因品牌统一而跨档收敛
 * （社区档与正式版都叫 QiZhiKitty），目录名则必须保持档位唯一，
 * 否则两个档会写进同一个工作区根、互相覆盖。
 */
export function resolveDefaultWorkspaceDirectoryName(
  profile = resolveRuntimeProfile(),
): string {
  return PROFILE_IDENTITIES[profile].userDataDirName
}

export function resolveDevInstanceId(): string | undefined {
  if (app.isPackaged) return undefined

  const instanceId = process.env.TABTIN_DEV_INSTANCE?.trim().toLowerCase()
  if (!instanceId) return undefined
  if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(instanceId)) {
    throw new Error('TABTIN_DEV_INSTANCE 只能包含小写字母、数字和连字符，最长 32 位')
  }
  return instanceId
}

export function applyRuntimeAppIdentity(): TabTinAppIdentity {
  const identity = resolveRuntimeAppIdentity()
  const instanceId = resolveDevInstanceId()
  const productName = instanceId ? `${identity.productName} (${instanceId})` : identity.productName
  const userDataDirName = instanceId ? `${identity.userDataDirName}-${instanceId}` : identity.userDataDirName

  app.setName(productName)

  const appDataPath = app.getPath('appData')
  const profileRoot = join(appDataPath, userDataDirName)
  app.setPath('userData', profileRoot)

  // Keep managed/index data and execution-control state profile-scoped while
  // preserving the domain contract that Workspace.working_dir is external
  // and must never be derived from either root.
  if (app.isPackaged || !process.env.TABTIN_DATA_ROOT) {
    process.env.TABTIN_DATA_ROOT = profileRoot
  }
  if (app.isPackaged || !process.env.TABTIN_RUNTIME_ROOT) {
    process.env.TABTIN_RUNTIME_ROOT = join(profileRoot, 'runtime')
  }
  if (app.isPackaged || !process.env.TABTIN_CONFIG_DIR) {
    process.env.TABTIN_CONFIG_DIR = process.env.TABTIN_RUNTIME_ROOT
  }

  process.env.TABTIN_RUNTIME_PROFILE = identity.profile
  process.env.TABTIN_APP_ID = identity.appId
  process.env.TABTIN_APP_PRODUCT_NAME = productName

  return identity
}

/** Electron 在 app-identity 上线（6b8153cc8，2026-06-11）之前取 package.json name 作为 userData 目录名的历史形态。 */
const LEGACY_DEFAULT_USER_DATA_DIR_NAME = 'tabtin-electron'

/**
 * 所有已知的 userData 目录名：各 profile 的目录 + Electron 历史默认目录名。
 *
 * 设备身份已改为硬件锚定（`deviceFingerprint.ts`，）：有机标识时不再跨目录继承。
 * 本列表仍供清缓存探测、诊断等场景枚举同机历史目录；production 无硬件时仍可从
 * `tabtin-electron` 继承随机指纹作为回退。
 */
export function getKnownUserDataDirNames(): string[] {
  const profileDirs = Object.values(PROFILE_IDENTITIES).map((identity) => identity.userDataDirName)
  return [...profileDirs, LEGACY_DEFAULT_USER_DATA_DIR_NAME]
}
