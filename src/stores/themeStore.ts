import { create } from 'zustand'

export type ThemeId = 'cloud-dancer' | 'corundum-blue' | 'kiwi-green' | 'spicy-red' | 'teal-water' | 'new-year' | 'sakura-mist'
export type ThemeMode = 'light' | 'dark' | 'system'
export type NavLayout = 'sidebar' | 'dock'

export interface ThemeInfo {
  id: ThemeId
  name: string
  description: string
  primaryColor: string
  bgColor: string
}

export const themes: ThemeInfo[] = [
  {
    id: 'cloud-dancer',
    name: '云上舞白',
    description: 'Pantone 2026 年度色',
    primaryColor: '#8B7355',
    bgColor: '#F0EEE9'
  },
  {
    id: 'corundum-blue',
    name: '刚玉蓝',
    description: 'RAL 220 40 10',
    primaryColor: '#4A6670',
    bgColor: '#E8EEF0'
  },
  {
    id: 'kiwi-green',
    name: '冰猕猴桃汁绿',
    description: 'RAL 120 90 20',
    primaryColor: '#7A9A5C',
    bgColor: '#E8F0E4'
  },
  {
    id: 'spicy-red',
    name: '辛辣红',
    description: 'RAL 030 40 40',
    primaryColor: '#8B4049',
    bgColor: '#F0E8E8'
  },
  {
    id: 'teal-water',
    name: '明水鸭色',
    description: 'RAL 180 80 10',
    primaryColor: '#5A8A8A',
    bgColor: '#E4F0F0'
  },
  {
    id: 'new-year',
    name: '新年快乐',
    description: 'Happy New Year 2026',
    primaryColor: '#E60012',
    bgColor: '#FFF0F0'
  },
  {
    id: 'sakura-mist',
    name: '樱雾粉',
    description: '温柔、治愈的高级粉',
    primaryColor: '#D86A8A',
    bgColor: '#FFF2F7'
  }
]

interface ThemeState {
  currentTheme: ThemeId
  themeMode: ThemeMode
  navLayout: NavLayout
  dockAutoHide: boolean
  isLoaded: boolean
  setTheme: (theme: ThemeId) => void
  setThemeMode: (mode: ThemeMode) => void
  setNavLayout: (layout: NavLayout) => void
  setDockAutoHide: (v: boolean) => void
  toggleThemeMode: () => void
  loadTheme: () => Promise<void>
}

export const useThemeStore = create<ThemeState>()((set, get) => ({
  currentTheme: 'new-year',
  themeMode: 'light',
  navLayout: 'dock',
  dockAutoHide: true,
  isLoaded: false,

  setTheme: async (theme) => {
    set({ currentTheme: theme })
    try {
      await window.electronAPI.config.set('theme', theme)
    } catch (e) {
      console.error('保存主题失败:', e)
    }
  },

  setThemeMode: async (mode) => {
    set({ themeMode: mode })
    try {
      await window.electronAPI.config.set('themeMode', mode)
    } catch (e) {
      console.error('保存主题模式失败:', e)
    }
  },

  setNavLayout: async (layout) => {
    set({ navLayout: layout })
    try {
      await window.electronAPI.config.set('navLayout', layout)
    } catch (e) {
      console.error('保存导航布局失败:', e)
    }
  },

  setDockAutoHide: async (v) => {
    set({ dockAutoHide: v })
    try {
      await window.electronAPI.config.set('dockAutoHide', v)
    } catch (e) {
      console.error('保存 Dock 自动收起失败:', e)
    }
  },

  toggleThemeMode: () => {
    const newMode = get().themeMode === 'light' ? 'dark' : 'light'
    get().setThemeMode(newMode)
  },

  loadTheme: async () => {
    try {
      const theme = await window.electronAPI.config.get('theme') as ThemeId
      const themeMode = await window.electronAPI.config.get('themeMode') as ThemeMode
      let navLayout = await window.electronAPI.config.get('navLayout') as NavLayout | undefined
      const dockAutoHide = await window.electronAPI.config.get('dockAutoHide') as boolean | undefined

      // 一次性迁移：旧版本没有 navLayout 选项，统一切换到 Dock 模式
      const migrated = await window.electronAPI.config.get('navLayoutMigratedV6') as boolean | undefined
      if (!migrated) {
        navLayout = 'dock'
        try {
          await window.electronAPI.config.set('navLayout', 'dock')
          await window.electronAPI.config.set('navLayoutMigratedV6', true)
        } catch (e) {
          console.error('迁移导航布局失败:', e)
        }
      }

      set({
        currentTheme: theme || 'cloud-dancer',
        themeMode: themeMode || 'light',
        navLayout: navLayout || 'dock',
        dockAutoHide: dockAutoHide ?? true,
        isLoaded: true
      })
    } catch (e) {
      console.error('加载主题失败:', e)
      set({ isLoaded: true })
    }
  }
}))

// 获取当前主题信息
export const getThemeInfo = (themeId: ThemeId): ThemeInfo => {
  return themes.find(t => t.id === themeId) || themes[0]
}
