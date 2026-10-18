<script setup>
// 通用右键菜单（M8）：不引 UI 库，自写一个够用的就够
//
// 三个必须做对的小事（缺一个就会"看起来像坏了"）：
// 1. **点击外部关闭**：用 capture 阶段的 pointerdown 监听，否则会被同一次点击的 mouseup 又打开
// 2. **Esc 关闭**：键盘用户必须能退出菜单（也是无障碍的最低要求）
// 3. **超出视口自动翻转**：菜单在右下角弹出时会被裁掉，按视口尺寸翻到光标左侧/上方
//
// 定位方式：fixed + 光标坐标（相对视口），并夹取到 [8, 视口-菜单尺寸-8] 内 —— 比算"翻转"更简单可靠。

import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';

const props = defineProps({
  /** 是否显示 */
  open: { type: Boolean, default: false },
  /** 光标位置（视口坐标） */
  x: { type: Number, default: 0 },
  y: { type: Number, default: 0 },
  /**
   * 菜单项：[{ key, label, icon?, shortcut?, disabled?, danger?, divider? }]
   * divider:true 渲染分隔线（该条其它字段忽略）
   */
  items: { type: Array, default: () => [] },
});
const emit = defineEmits(['close', 'pick']);

const menuRef = ref(null);
const position = ref({ left: 0, top: 0 });
/** 视口边距：贴边 8px，避免菜单贴死在屏幕边缘 */
const VIEWPORT_MARGIN = 8;

const visibleItems = computed(() => props.items.filter(Boolean));

/** 计算位置：先按光标放，再夹取到视口内（菜单尺寸要等 DOM 渲染后才知道） */
async function placeMenu() {
  await nextTick();
  const el = menuRef.value;
  if (!el) return;
  const rect = el.getBoundingClientRect();
  const maxLeft = window.innerWidth - rect.width - VIEWPORT_MARGIN;
  const maxTop = window.innerHeight - rect.height - VIEWPORT_MARGIN;
  position.value = {
    left: Math.max(VIEWPORT_MARGIN, Math.min(props.x, maxLeft)),
    top: Math.max(VIEWPORT_MARGIN, Math.min(props.y, maxTop)),
  };
}

/** 外部 pointerdown 关闭（capture：先于业务逻辑，避免"关掉又被同一次点击打开"） */
function onPointerDownOutside(event) {
  if (!props.open) return;
  if (menuRef.value && menuRef.value.contains(event.target)) return;
  emit('close');
}

/** Esc 关闭 */
function onKeyDown(event) {
  if (props.open && event.key === 'Escape') {
    event.stopPropagation();
    emit('close');
  }
}

watch(
  () => props.open,
  (open) => {
    if (!open) return;
    void placeMenu();
    document.addEventListener('pointerdown', onPointerDownOutside, true);
    document.addEventListener('keydown', onKeyDown, true);
  },
);

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onPointerDownOutside, true);
  document.removeEventListener('keydown', onKeyDown, true);
});

function pick(item) {
  if (item.disabled || item.divider) return;
  emit('pick', item.key);
  emit('close');
}
</script>

<template>
  <Teleport to="body">
    <div
      v-if="open"
      ref="menuRef"
      class="context-menu"
      role="menu"
      data-testid="context-menu"
      :style="{ left: `${position.left}px`, top: `${position.top}px` }"
      @contextmenu.prevent
    >
      <template v-for="(item, index) in visibleItems" :key="item.divider ? `divider-${index}` : item.key">
        <div v-if="item.divider" class="context-menu__divider" role="separator"></div>
        <button
          v-else
          type="button"
          class="context-menu__item"
          role="menuitem"
          :disabled="item.disabled"
          :class="{ 'context-menu__item--danger': item.danger }"
          :data-testid="`menu-item-${item.key}`"
          @click="pick(item)"
        >
          <span class="context-menu__label">{{ item.label }}</span>
          <span v-if="item.shortcut" class="context-menu__shortcut">{{ item.shortcut }}</span>
        </button>
      </template>
    </div>
  </Teleport>
</template>
