import * as THREE from './vendor/three.module.min.js';

const cloud = document.querySelector('#cloud');
const empty = document.querySelector('#empty');
const status = document.querySelector('#status');
const search = document.querySelector('#search');
const tooltip = document.querySelector('#tooltip');
const contextMenu = document.querySelector('#context-menu');
const buttons = [...document.querySelectorAll('[data-filter]')];
const flowSpeed = document.querySelector('#flow-speed');
const flowSpeedValue = document.querySelector('#flow-speed-value');

const INITIAL_RENDER_MAX = 60;
const PREFERENCES_KEY = 'bookmark-cloud-preferences';
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(48, innerWidth / innerHeight, 0.1, 100);
camera.position.z = 16;
const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
cloud.append(renderer.domElement);

const cloudGroup = new THREE.Group();
scene.add(cloudGroup);
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
let bookmarks = [];
let tabs = [];
let activeFilter = 'bookmarks';
let clickableMeshes = [];
let hoveredMesh = null;
let contextLink = null;
let waterfallSpeed = 4;
let flowLinks = [];
const clock = new THREE.Clock();

function speedLabel(speed) {
  return speed <= 3 ? '缓慢' : speed <= 6 ? '中等' : '快速';
}

function savePreferences() {
  localStorage.setItem(PREFERENCES_KEY, JSON.stringify({ waterfallSpeed, activeFilter }));
}

function loadPreferences() {
  try {
    const preferences = JSON.parse(localStorage.getItem(PREFERENCES_KEY) || '{}');
    if (Number.isFinite(preferences.waterfallSpeed) && preferences.waterfallSpeed >= 1 && preferences.waterfallSpeed <= 10) {
      waterfallSpeed = preferences.waterfallSpeed;
    }
    if (['all', 'bookmarks', 'tabs'].includes(preferences.activeFilter)) activeFilter = preferences.activeFilter;
  } catch (error) {
    console.warn('无法读取本地展示设置', error);
  }
  flowSpeed.value = String(waterfallSpeed);
  flowSpeedValue.value = speedLabel(waterfallSpeed);
  buttons.forEach((button) => button.classList.toggle('is-active', button.dataset.filter === activeFilter));
}

// URL 哈希的前 6 个十六进制字符，保证同一链接颜色稳定。
function colorForUrl(url) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < url.length; index += 1) {
    hash ^= url.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `#${(hash >>> 0).toString(16).padStart(8, '0').slice(0, 6)}`;
}

function flattenBookmarks(nodes, results = [], folders = []) {
  for (const node of nodes) {
    if (node.url) results.push({ title: node.title || node.url, url: node.url, folders });
    if (node.children) {
      const childFolders = node.title ? [...folders, node.title] : folders;
      flattenBookmarks(node.children, results, childFolders);
    }
  }
  return results;
}

function sourceNodes() {
  if (activeFilter === 'bookmarks') return bookmarks;
  if (activeFilter === 'tabs') return tabs;
  return [...bookmarks, ...tabs];
}

function filteredNodes() {
  const query = search.value.trim().toLocaleLowerCase();
  if (!query) return sourceNodes();
  return sourceNodes().filter((node) => (
    node.title.toLocaleLowerCase().includes(query)
    || node.url.toLocaleLowerCase().includes(query)
    // 命中文件夹时，保留它下面（含子文件夹）的每一个书签。
    || node.folders?.some((folder) => folder.toLocaleLowerCase().includes(query))
  ));
}

function disposeObject(object) {
  object.traverse((child) => {
    child.geometry?.dispose();
    const material = child.material;
    if (material?.map) material.map.dispose();
    material?.dispose();
  });
}

function clearCloud() {
  hoveredMesh = null;
  cloud.style.cursor = 'default';
  hideTooltip();
  while (cloudGroup.children.length) {
    const child = cloudGroup.children.pop();
    disposeObject(child);
  }
  clickableMeshes = [];
}

function textMesh(link, fontSize) {
  const label = link.title.length > 10 ? `${link.title.slice(0, 9)}…` : link.title;
  const padding = 16;
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');
  context.font = `600 ${fontSize}px system-ui, sans-serif`;
  const width = Math.ceil(context.measureText(label).width) + padding * 2;
  const height = Math.ceil(fontSize * 1.45) + padding * 2;
  const scale = 2;
  canvas.width = width * scale;
  canvas.height = height * scale;
  context.scale(scale, scale);
  context.font = `600 ${fontSize}px system-ui, sans-serif`;
  context.fillStyle = colorForUrl(link.url);
  context.shadowColor = context.fillStyle;
  context.shadowBlur = 12;
  context.fillText(label, padding, fontSize + padding * .55);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const material = new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false, side: THREE.DoubleSide });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(width / 95, height / 95), material);
  mesh.userData.url = link.url;
  mesh.userData.title = link.title;
  mesh.userData.targetScale = 1;
  mesh.userData.size = { width: width / 95, height: height / 95 };
  return mesh;
}

function waterfallBounds() {
  const halfHeight = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * camera.position.z;
  return { x: halfHeight * camera.aspect, y: halfHeight };
}

function placeAtWaterfallEntry(mesh, bounds, initial = false) {
  const { width, height } = mesh.userData.size;
  const minX = -bounds.x + width * .6;
  const maxX = bounds.x - width * .6;
  const minY = -bounds.y + height * .6;
  const maxY = bounds.y - height * .6;
  mesh.position.set(
    THREE.MathUtils.randFloat(minX, maxX),
    initial ? THREE.MathUtils.randFloat(minY, maxY) : maxY,
    0,
  );
}

function randomFlowLink() {
  return flowLinks[Math.floor(Math.random() * flowLinks.length)];
}

function replaceWaterfallMesh(oldMesh, bounds) {
  const index = clickableMeshes.indexOf(oldMesh);
  const link = randomFlowLink();
  if (index < 0 || !link) return;
  const mesh = textMesh(link, 30 + Math.floor(Math.random() * 3) * 4);
  placeAtWaterfallEntry(mesh, bounds);
  mesh.lookAt(camera.position);
  mesh.userData.waterfall = { bounds, speed: THREE.MathUtils.randFloat(.65, 1.35) };
  cloudGroup.remove(oldMesh);
  disposeObject(oldMesh);
  cloudGroup.add(mesh);
  clickableMeshes[index] = mesh;
}

function renderCloud() {
  const all = filteredNodes();
  const nodes = all.slice(0, INITIAL_RENDER_MAX);
  flowLinks = all;
  clearCloud();
  empty.hidden = nodes.length > 0;
  status.hidden = all.length <= INITIAL_RENDER_MAX;
  status.textContent = `当前共 ${all.length} 个结果；首屏渲染 ${INITIAL_RENDER_MAX} 个并持续随机掉落`;
  const bounds = waterfallBounds();
  nodes.forEach((link, index) => {
    const mesh = textMesh(link, 30 + (index % 3) * 4);
    placeAtWaterfallEntry(mesh, bounds, true);
    mesh.lookAt(camera.position);
    mesh.userData.waterfall = { bounds, speed: THREE.MathUtils.randFloat(.65, 1.35) };
    cloudGroup.add(mesh);
    clickableMeshes.push(mesh);
  });
}

async function loadLinks() {
  try {
    const [tree, currentTabs] = await Promise.all([chrome.bookmarks.getTree(), chrome.tabs.query({ currentWindow: true })]);
    bookmarks = flattenBookmarks(tree);
    tabs = currentTabs.filter((tab) => /^https?:/.test(tab.url || '')).map((tab) => ({ title: tab.title || tab.url, url: tab.url }));
    renderCloud();
  } catch (error) {
    console.error('无法读取书签或标签页', error);
    empty.textContent = '无法读取浏览器内容，请检查扩展权限';
    empty.hidden = false;
  }
}

function onResize() {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  renderCloud();
}

function updatePointer(event) {
  const rect = renderer.domElement.getBoundingClientRect();
  pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
}

function placeTooltip(event) {
  const gap = 14;
  const left = Math.min(event.clientX + gap, innerWidth - tooltip.offsetWidth - gap);
  const top = Math.min(event.clientY + gap, innerHeight - tooltip.offsetHeight - gap);
  tooltip.style.left = `${Math.max(gap, left)}px`;
  tooltip.style.top = `${Math.max(gap, top)}px`;
}

function hideTooltip() {
  tooltip.hidden = true;
}

function linkAtEvent(event) {
  updatePointer(event);
  raycaster.setFromCamera(pointer, camera);
  return raycaster.intersectObjects(clickableMeshes, false)[0]?.object || null;
}

function hideContextMenu() {
  contextMenu.hidden = true;
  contextLink = null;
}

function updateHover(event) {
  updatePointer(event);
  raycaster.setFromCamera(pointer, camera);
  const nextHovered = raycaster.intersectObjects(clickableMeshes, false)[0]?.object || null;
  if (nextHovered === hoveredMesh) {
    if (hoveredMesh) placeTooltip(event);
    return;
  }
  if (hoveredMesh) hoveredMesh.userData.targetScale = 1;
  hoveredMesh = nextHovered;
  if (hoveredMesh) hoveredMesh.userData.targetScale = 1.2;
  if (hoveredMesh) {
    tooltip.replaceChildren();
    const title = document.createElement('div');
    title.className = 'tooltip__title';
    title.textContent = hoveredMesh.userData.title;
    const url = document.createElement('div');
    url.className = 'tooltip__url';
    url.textContent = hoveredMesh.userData.url;
    tooltip.append(title, url);
    tooltip.hidden = false;
    placeTooltip(event);
  } else {
    hideTooltip();
  }
  cloud.style.cursor = hoveredMesh ? 'pointer' : 'default';
}

cloud.addEventListener('pointermove', updateHover);
cloud.addEventListener('click', (event) => {
  const hit = linkAtEvent(event);
  if (hit) location.assign(hit.userData.url);
  hideContextMenu();
});
cloud.addEventListener('contextmenu', (event) => {
  const hit = linkAtEvent(event);
  if (!hit) {
    hideContextMenu();
    return;
  }
  event.preventDefault();
  contextLink = hit.userData;
  hideTooltip();
  contextMenu.hidden = false;
  const gap = 8;
  contextMenu.style.left = `${Math.min(event.clientX, innerWidth - contextMenu.offsetWidth - gap)}px`;
  contextMenu.style.top = `${Math.min(event.clientY, innerHeight - contextMenu.offsetHeight - gap)}px`;
});
cloud.addEventListener('pointerleave', () => {
  if (hoveredMesh) hoveredMesh.userData.targetScale = 1;
  hoveredMesh = null;
  cloud.style.cursor = 'default';
  hideTooltip();
});
contextMenu.addEventListener('click', (event) => {
  const action = event.target.closest('[data-action]')?.dataset.action;
  if (!action || !contextLink) return;
  const { url } = contextLink;
  hideContextMenu();
  if (action === 'open') location.assign(url);
  if (action === 'open-new-tab') chrome.tabs.create({ url });
});
addEventListener('pointerdown', (event) => {
  if (!contextMenu.contains(event.target)) hideContextMenu();
});

buttons.forEach((button) => button.addEventListener('click', () => {
  activeFilter = button.dataset.filter;
  buttons.forEach((item) => item.classList.toggle('is-active', item === button));
  savePreferences();
  renderCloud();
}));

flowSpeed.addEventListener('input', () => {
  waterfallSpeed = Number(flowSpeed.value);
  flowSpeedValue.value = speedLabel(waterfallSpeed);
  savePreferences();
});
search.addEventListener('input', renderCloud);
addEventListener('resize', onResize);

function animate() {
  const delta = Math.min(clock.getDelta(), .05);
  // 命中文字时暂停瀑布，方便阅读和点击。
  // 少于首屏容量时静态展示，避免稀疏内容无意义地循环滚动。
  if (!hoveredMesh && !contextLink && flowLinks.length >= INITIAL_RENDER_MAX) {
    clickableMeshes.forEach((mesh) => {
      const flow = mesh.userData.waterfall;
      if (!flow) return;
      const distance = waterfallSpeed * delta * .52 * flow.speed;
      mesh.position.y -= distance;
      const { x, y } = flow.bounds;
      if (mesh.position.y < -y + mesh.userData.size.height * .6) replaceWaterfallMesh(mesh, { x, y });
    });
  }
  clickableMeshes.forEach((mesh) => {
    const nextScale = THREE.MathUtils.lerp(mesh.scale.x, mesh.userData.targetScale, .2);
    mesh.scale.setScalar(nextScale);
  });
  renderer.render(scene, camera);
  requestAnimationFrame(animate);
}

animate();
loadPreferences();
loadLinks();
