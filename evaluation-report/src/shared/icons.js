/*
Phosphor Icons, thin weight. Source: https://github.com/phosphor-icons/core
MIT License

Copyright (c) 2023 Phosphor Icons

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

*/
(() => {
  'use strict';
  const icons = {
  "shuffle": {
    "viewBox": "0 0 256 256",
    "paths": [
      "M234.83,181.17a4,4,0,0,1,0,5.66l-24,24a4,4,0,0,1-5.66-5.66L222.34,188h-21.4a68.15,68.15,0,0,1-55.34-28.48l-41.71-58.39A60.11,60.11,0,0,0,55.06,76H32a4,4,0,0,1,0-8H55.06A68.15,68.15,0,0,1,110.4,96.48l41.71,58.39A60.11,60.11,0,0,0,200.94,180h21.4l-17.17-17.17a4,4,0,0,1,5.66-5.66Zm-89.49-77.44a4,4,0,0,0,5.58-.93l1.19-1.67A60.11,60.11,0,0,1,200.94,76h21.4L205.17,93.17a4,4,0,0,0,5.66,5.66l24-24a4,4,0,0,0,0-5.66l-24-24a4,4,0,0,0-5.66,5.66L222.34,68h-21.4A68.15,68.15,0,0,0,145.6,96.48l-1.19,1.67A4,4,0,0,0,145.34,103.73Zm-34.68,48.54a4,4,0,0,0-5.58.93l-1.19,1.67A60.11,60.11,0,0,1,55.06,180H32a4,4,0,0,0,0,8H55.06a68.15,68.15,0,0,0,55.34-28.48l1.19-1.67A4,4,0,0,0,110.66,152.27Z"
    ]
  }
};
  window.ReportIcons = {
    symbols() {
      return Object.entries(icons).map(([name, icon]) => `<symbol id="phosphor-${name}" viewBox="${icon.viewBox}" preserveAspectRatio="xMidYMid meet">${icon.paths.map(path => `<path d="${path}"/>`).join('')}</symbol>`).join('');
    },
    draw(name, x, y, width, height = width, extra = '') {
      if (!Object.hasOwn(icons, name)) throw new Error(`未知图标：${name}`);
      return `<use class="diagram-icon ${extra}" href="#phosphor-${name}" x="${x}" y="${y}" width="${width}" height="${height}" aria-hidden="true"/>`;
    },
  };
})();
