import { registerOverlay } from "./hmr.js";
import { logger } from "./59.js";
function _define_property(obj, key, value) {
    if (key in obj) Object.defineProperty(obj, key, {
        value: value,
        enumerable: true,
        configurable: true,
        writable: true
    });
    else obj[key] = value;
    return obj;
}
const { HTMLElement: HTMLElement = class {
}, customElements: customElements } = 'undefined' != typeof window ? window : globalThis;
class ErrorOverlay extends HTMLElement {
    constructor(html){
        var _root_querySelector, _root_querySelector1;
        super(), _define_property(this, "close", (immediate = false)=>{
            const remove = ()=>{
                var _this_parentNode;
                return null == (_this_parentNode = this.parentNode) ? void 0 : _this_parentNode.removeChild(this);
            };
            if (this.animate && true !== immediate) this.animate([
                {
                    opacity: 1
                },
                {
                    opacity: 0
                }
            ], {
                duration: 300,
                easing: 'ease-out'
            }).addEventListener('finish', remove);
            else remove();
        });
        if (!this.attachShadow) return void logger.warn('[rsbuild] Error overlay disabled: Shadow DOM not supported in this browser.');
        const root = this.attachShadow({
            mode: 'open'
        });
        root.innerHTML = html;
        null == (_root_querySelector = root.querySelector('.close')) || _root_querySelector.addEventListener('click', this.close);
        this.addEventListener('click', this.close);
        null == (_root_querySelector1 = root.querySelector('.container')) || _root_querySelector1.addEventListener('click', (e)=>{
            if (e.target) {
                const { file } = e.target.dataset;
                if (file) fetch(`/__open-in-editor?file=${encodeURIComponent(file)}`);
            }
            e.stopPropagation();
        });
        const onEscKeydown = (e)=>{
            if ('Escape' === e.key || 'Escape' === e.code) this.close();
            document.removeEventListener('keydown', onEscKeydown);
        };
        document.addEventListener('keydown', onEscKeydown);
    }
}
const overlayId = 'rsbuild-error-overlay';
if (customElements && !customElements.get(overlayId)) customElements.define(overlayId, ErrorOverlay);
function createOverlay(html) {
    clearOverlay();
    document.body.appendChild(new ErrorOverlay(html));
}
function clearOverlay() {
    document.querySelectorAll(overlayId).forEach((n)=>{
        n.close(true);
    });
}
if ('undefined' != typeof document) registerOverlay(createOverlay, clearOverlay);
else logger.info('[rsbuild] Error overlay unavailable: Running in non-browser environment. To suppress this message, set `dev.client.overlay: false` in your configuration.');
