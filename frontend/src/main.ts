import { createApp } from 'vue'
import { createPinia } from 'pinia'
import ElementPlus from 'element-plus'
import 'element-plus/dist/index.css'
import App from './App.vue'
import router from './router'
import { ensureReconciled } from './utils/db'
import './style.css'

// 重启 / 重开后先续做中断在确认阶段的计划，再挂载界面，保证台账一开始就一致
ensureReconciled().catch((error) => {
  console.error('[plan] 重启恢复失败', error)
}).finally(() => {
  createApp(App)
    .use(createPinia())
    .use(ElementPlus)
    .use(router)
    .mount('#app')
})
