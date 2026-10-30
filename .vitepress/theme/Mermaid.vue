<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useData } from 'vitepress';

const props = defineProps<{ code: string }>();
const source = computed(() => decodeURIComponent(props.code));
const { isDark } = useData();
const svg = ref('');
const failed = ref(false);
const sequence = Math.random().toString(36).slice(2);
let renders = 0;

const fontFamily = "system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif";

function themeVariables(dark: boolean) {
  return dark
    ? {
        background: '#182e38',
        primaryColor: '#1d3743',
        primaryTextColor: '#f4f7f7',
        primaryBorderColor: '#69d6c2',
        secondaryColor: '#13252d',
        tertiaryColor: '#13252d',
        lineColor: '#69d6c2',
        textColor: '#f4f7f7',
        mainBkg: '#1d3743',
        nodeBorder: '#69d6c2',
        clusterBkg: '#13252d',
        clusterBorder: '#3b5a68',
        edgeLabelBackground: '#182e38',
        noteBkgColor: '#13252d',
        noteTextColor: '#f4f7f7',
        noteBorderColor: '#3b5a68',
        fontFamily,
      }
    : {
        background: '#ffffff',
        primaryColor: '#f4f7f7',
        primaryTextColor: '#182e38',
        primaryBorderColor: '#087f78',
        secondaryColor: '#e8f1f0',
        tertiaryColor: '#e8f1f0',
        lineColor: '#087f78',
        textColor: '#182e38',
        mainBkg: '#f4f7f7',
        nodeBorder: '#087f78',
        clusterBkg: '#e8f1f0',
        clusterBorder: '#a9c4c2',
        edgeLabelBackground: '#ffffff',
        noteBkgColor: '#e8f1f0',
        noteTextColor: '#182e38',
        noteBorderColor: '#a9c4c2',
        fontFamily,
      };
}

async function render() {
  const run = ++renders;
  try {
    const { default: mermaid } = await import('mermaid');
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      theme: 'base',
      themeVariables: themeVariables(isDark.value),
      fontFamily,
      flowchart: { useMaxWidth: true, htmlLabels: true, curve: 'linear' },
      timeline: { useMaxWidth: true },
      sequence: { useMaxWidth: true },
    });
    const result = await mermaid.render(`mermaid-${sequence}-${run}`, source.value);
    if (run === renders) svg.value = result.svg;
  } catch {
    failed.value = true;
  }
}

onMounted(render);
watch(isDark, render);
</script>

<template>
  <div class="mermaid-diagram">
    <div v-if="svg" class="mermaid-svg" v-html="svg" />
    <pre v-else class="mermaid-source"><code>{{ source }}</code></pre>
    <p v-if="failed" class="mermaid-error">The diagram could not be drawn. Its source is shown instead.</p>
  </div>
</template>
