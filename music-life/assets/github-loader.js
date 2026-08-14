const partUrls = Array.from({ length: 12 }, (_, index) => `./assets/index-BYu0IQkG.part${index}.txt`);

try {
  const buffers = await Promise.all(partUrls.map(async (url) => {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`无法加载程序分块：${url}`);
    return new Uint8Array(await response.arrayBuffer());
  }));
  const totalLength = buffers.reduce((sum, buffer) => sum + buffer.length, 0);
  const source = new Uint8Array(totalLength);
  let offset = 0;
  for (const buffer of buffers) {
    source.set(buffer, offset);
    offset += buffer.length;
  }
  const script = document.createElement("script");
  script.textContent = new TextDecoder().decode(source);
  document.head.appendChild(script);
} catch (error) {
  console.error(error);
  document.body.innerHTML = `<main style="padding:40px;font-family:sans-serif"><h1>音乐人生加载失败</h1><p>${error instanceof Error ? error.message : "请刷新页面后重试。"}</p></main>`;
}
