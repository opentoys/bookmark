import * as THREE from './vendor/three.module.min.js';

const cloud = document.querySelector('#cloud');
const empty = document.querySelector('#empty');
const status = document.querySelector('#status');
const search = document.querySelector('#search');
const buttons = [...document.querySelectorAll('[data-filter]')];

const MAX_VISIBLE = 100;
const ELLIPSOID_WIDTH_SCALE = 1.45;
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(48, innerWidth / innerHeight, 0.1, 100);
camera.position.z = 16;
let sphereRadius = 1;
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
let dragging = null;
let hoveredMesh = null;

function updateSphereRadius() {
  // 用球体轮廓的切线投影计算，使其屏幕投影直径为视口高度的 80%。
  const verticalHalfFov = THREE.MathUtils.degToRad(camera.fov / 2);
  const sphereAngularHalfSize = Math.atan(Math.tan(verticalHalfFov) * .8);
  sphereRadius = camera.position.z * Math.sin(sphereAngularHalfSize);
}
updateSphereRadius();

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
    if (node.url) results.push({ title: node.title || node.url, url: node.url, folders, spherePoint: randomSpherePoint() });
    if (node.children) {
      const childFolders = node.title ? [...folders, node.title] : folders;
      flattenBookmarks(node.children, results, childFolders);
    }
  }
  return results;
}

function randomSpherePoint() {
  // 均匀随机取球面坐标；每个链接只在读取时生成一次，因此筛选不会令它跳动。
  return {
    phi: Math.acos(THREE.MathUtils.lerp(-1, 1, Math.random())),
    theta: Math.random() * Math.PI * 2,
  };
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
  cloud.style.cursor = 'grab';
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
  return mesh;
}

function spherePosition(link) {
  const point = new THREE.Vector3().setFromSphericalCoords(sphereRadius, link.spherePoint.phi, link.spherePoint.theta);
  point.x *= ELLIPSOID_WIDTH_SCALE;
  return point;
}

function ellipsoidNormal(position) {
  const horizontalRadius = sphereRadius * ELLIPSOID_WIDTH_SCALE;
  return new THREE.Vector3(
    position.x / (horizontalRadius * horizontalRadius),
    position.y / (sphereRadius * sphereRadius),
    position.z / (sphereRadius * sphereRadius),
  ).normalize();
}

function renderCloud() {
  const all = filteredNodes();
  const nodes = all.slice(0, MAX_VISIBLE);
  clearCloud();
  empty.hidden = nodes.length > 0;
  status.hidden = all.length <= MAX_VISIBLE;
  status.textContent = `球面最多显示 ${MAX_VISIBLE} / ${all.length} 个结果；请用搜索缩小范围`;

  nodes.forEach((link, index) => {
    const mesh = textMesh(link, 36 + (index % 3) * 5);
    const position = spherePosition(link);
    mesh.position.copy(position);
    // 平面沿椭球面法线摆放，形成真正贴合曲面的文字云。
    mesh.lookAt(position.clone().add(ellipsoidNormal(position)));
    cloudGroup.add(mesh);
    clickableMeshes.push(mesh);
  });

  // 少量文字时使用淡淡的球框，帮助识别球体轮廓。
  if (nodes.length && nodes.length < 35) {
    const frame = new THREE.LineSegments(
      new THREE.WireframeGeometry(new THREE.IcosahedronGeometry(sphereRadius, 2)),
      new THREE.LineBasicMaterial({ color: 0x8d9aad, transparent: true, opacity: .15 })
    );
    frame.scale.x = ELLIPSOID_WIDTH_SCALE;
    cloudGroup.add(frame);
  }
}

async function loadLinks() {
  try {
    const [tree, currentTabs] = await Promise.all([chrome.bookmarks.getTree(), chrome.tabs.query({ currentWindow: true })]);
    bookmarks = flattenBookmarks(tree);
    tabs = currentTabs.filter((tab) => /^https?:/.test(tab.url || '')).map((tab) => ({ title: tab.title || tab.url, url: tab.url, spherePoint: randomSpherePoint() }));
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
  updateSphereRadius();
  renderer.setSize(innerWidth, innerHeight);
  renderCloud();
}

function updatePointer(event) {
  const rect = renderer.domElement.getBoundingClientRect();
  pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
}

function updateHover(event) {
  updatePointer(event);
  raycaster.setFromCamera(pointer, camera);
  const nextHovered = raycaster.intersectObjects(clickableMeshes, false)[0]?.object || null;
  if (nextHovered === hoveredMesh) return;
  if (hoveredMesh) hoveredMesh.userData.targetScale = 1;
  hoveredMesh = nextHovered;
  if (hoveredMesh) hoveredMesh.userData.targetScale = 1.2;
  cloud.style.cursor = hoveredMesh ? 'pointer' : 'grab';
}

cloud.addEventListener('pointerdown', (event) => {
  dragging = { x: event.clientX, y: event.clientY, moved: false };
  cloud.setPointerCapture(event.pointerId);
  cloud.classList.add('is-dragging');
  cloud.style.cursor = 'grabbing';
});
cloud.addEventListener('pointermove', (event) => {
  if (!dragging) {
    updateHover(event);
    return;
  }
  const dx = event.clientX - dragging.x;
  const dy = event.clientY - dragging.y;
  if (Math.abs(dx) + Math.abs(dy) > 2) dragging.moved = true;
  cloudGroup.rotation.y += dx * .008;
  cloudGroup.rotation.x = THREE.MathUtils.clamp(cloudGroup.rotation.x + dy * .008, -1.3, 1.3);
  dragging.x = event.clientX;
  dragging.y = event.clientY;
});
cloud.addEventListener('pointerup', (event) => {
  const wasDrag = dragging?.moved;
  dragging = null;
  cloud.classList.remove('is-dragging');
  if (wasDrag) {
    updateHover(event);
    return;
  }
  updatePointer(event);
  raycaster.setFromCamera(pointer, camera);
  const hit = raycaster.intersectObjects(clickableMeshes, false)[0];
  if (hit) location.assign(hit.object.userData.url);
});
cloud.addEventListener('pointercancel', () => { dragging = null; cloud.classList.remove('is-dragging'); cloud.style.cursor = 'grab'; });
cloud.addEventListener('pointerleave', () => {
  if (hoveredMesh) hoveredMesh.userData.targetScale = 1;
  hoveredMesh = null;
  cloud.style.cursor = 'grab';
});

buttons.forEach((button) => button.addEventListener('click', () => {
  activeFilter = button.dataset.filter;
  buttons.forEach((item) => item.classList.toggle('is-active', item === button));
  renderCloud();
}));
search.addEventListener('input', renderCloud);
addEventListener('resize', onResize);

function animate() {
  clickableMeshes.forEach((mesh) => {
    const nextScale = THREE.MathUtils.lerp(mesh.scale.x, mesh.userData.targetScale, .2);
    mesh.scale.setScalar(nextScale);
  });
  renderer.render(scene, camera);
  requestAnimationFrame(animate);
}

animate();
loadLinks();
