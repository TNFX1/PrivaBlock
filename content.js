let styleNode=null;
const earlyYoutubeCss=`
ytd-ad-slot-renderer,
ytd-in-feed-ad-layout-renderer,
ytd-promoted-sparkles-web-renderer,
ytd-promoted-sparkles-text-search-renderer,
ytd-display-ad-renderer,
ytd-promoted-video-renderer,
ytd-compact-promoted-video-renderer,
ytd-action-companion-ad-renderer,
ytd-companion-slot-renderer,
ytd-companion-ad-renderer,
ytd-banner-promo-renderer,
ytd-banner-promo-renderer-background,
ytd-video-masthead-ad-v3-renderer,
ytd-video-masthead-ad-renderer,
ytd-video-masthead-ad-primary-video-renderer,
ytd-video-masthead-ad-advertiser-info-renderer,
ytd-search-pyv-renderer,
ytd-reel-video-renderer:has(ytd-ad-slot-renderer),
ytd-rich-item-renderer:has(ytd-ad-slot-renderer),
ytd-rich-item-renderer:has(ytd-in-feed-ad-layout-renderer),
ytd-rich-item-renderer:has(ytd-promoted-sparkles-web-renderer),
ytd-rich-item-renderer:has(ytd-display-ad-renderer),
ytd-rich-item-renderer:has(ytd-promoted-video-renderer),
ytd-rich-item-renderer:has(ytd-action-companion-ad-renderer),
ytd-rich-item-renderer:has(ytd-companion-slot-renderer),
ytd-rich-section-renderer:has(ytd-ad-slot-renderer),
ytd-rich-section-renderer:has(ytd-in-feed-ad-layout-renderer),
ytd-rich-section-renderer:has(ytd-statement-banner-renderer),
#masthead-ad,
#player-ads,
.video-ads,
.ytp-ad-module,
.ytp-ad-player-overlay,
.ytp-ad-player-overlay-layout,
.ytp-ad-overlay-container,
.ytp-ad-text-overlay,
.ytp-ad-message-container,
.ytp-ad-progress-list,
.ytp-ad-image-overlay,
.ytp-ad-action-interstitial,
.ad-container,
.ad-container-renderer,
ytd-engagement-panel-section-list-renderer[target-id^="engagement-panel-ads"],
ytd-rich-item-renderer:has([aria-label*="Sponsored"]),
ytd-rich-item-renderer:has([aria-label*="sponsored"]),
{display:none!important}
.html5-video-player.ad-showing .html5-video-container,
.html5-video-player.ad-interrupting .html5-main-video,
.html5-video-player.ad-showing video.html5-main-video
{visibility:hidden!important}
`;

function installEarlyYoutubeCss(){
 if(!youtube())return;
 const root=document.documentElement;
 if(!root)return;
 const node=document.createElement("style");
 node.id="privablock-early-youtube";
 node.textContent=earlyYoutubeCss;
 root.prepend(node);
}
installEarlyYoutubeCss();
let scheduled=false;
let currentRules=[];
let observer=null;
const counted=new WeakSet();
const youtubeParents=["ytd-ad-slot-renderer","ytd-in-feed-ad-layout-renderer","ytd-promoted-sparkles-web-renderer","ytd-display-ad-renderer","ytd-promoted-video-renderer","ytd-action-companion-ad-renderer","ytd-companion-slot-renderer"];
function youtube(){return location.hostname==="youtube.com"||location.hostname.endsWith(".youtube.com")}
function validSelector(s){if(!s||s.length>2000)return false;try{document.querySelector(s);return true}catch{return false}}
function schedule(){if(scheduled)return;scheduled=true;setTimeout(apply,180)}
function hideYoutube(){
 if(!youtube())return 0;
 const selectors=[
  ...youtubeParents,
  "ytd-compact-promoted-video-renderer",
  "ytd-promoted-sparkles-text-search-renderer",
  "ytd-banner-promo-renderer",
  "ytd-video-masthead-ad-v3-renderer",
  "ytd-video-masthead-ad-renderer",
  "ytd-video-masthead-ad-primary-video-renderer",
  "ytd-video-masthead-ad-advertiser-info-renderer",
  "ytd-search-pyv-renderer",
  "ytd-reel-video-renderer:has(ytd-ad-slot-renderer)",
  "ytd-rich-section-renderer:has(ytd-ad-slot-renderer)",
  "ytd-rich-section-renderer:has(ytd-in-feed-ad-layout-renderer)",
  "ytd-rich-item-renderer:has([aria-label*=Sponsored])",
  "ytd-rich-item-renderer:has([aria-label*=sponsored])",
  "#masthead-ad",
  "#player-ads",
  ".video-ads",
  ".ytp-ad-module",
  ".ytp-ad-player-overlay",
  ".ytp-ad-player-overlay-layout",
  ".ytp-ad-overlay-container",
  ".ytp-ad-message-container",
  ".ytp-ad-image-overlay",
  ".ad-container"
 ];
 let count=0;
 for(const selector of selectors){
  let nodes=[];
  try{nodes=document.querySelectorAll(selector)}catch{}
  for(const node of nodes){
   let target=node;
   if(node.matches?.('ytd-ad-slot-renderer,ytd-in-feed-ad-layout-renderer')){
    const parent=node.closest('ytd-rich-item-renderer,ytd-rich-section-renderer,ytd-video-renderer')||node;
    target=parent;
   }
   if(target&&!counted.has(target)){
    counted.add(target);
    target.style.setProperty('display','none','important');
    target.setAttribute('data-privablock-hidden','1');
    count++;
   }
  }
 }
 return count
}
function ensureStyle(){if(!styleNode){styleNode=document.createElement("style");styleNode.id="privablock-cosmetic";(document.head||document.documentElement).appendChild(styleNode)}}
async function apply(){scheduled=false;try{const response=await browser.runtime.sendMessage({type:"getCosmetic",host:location.hostname});if(!response?.enabled){if(observer){observer.disconnect();observer=null}if(styleNode)styleNode.textContent="";return}currentRules=(response.rules||[]).filter(r=>r.type==="hide"&&validSelector(r.selector));if(!currentRules.length&&!youtube()){if(observer){observer.disconnect();observer=null}return}let count=hideYoutube();const css=[];for(const rule of currentRules)css.push(`${rule.selector}{display:none!important}`);if(css.length){ensureStyle();styleNode.textContent=css.join("\n");for(const rule of currentRules){let nodes=[];try{nodes=document.querySelectorAll(rule.selector)}catch{}for(const el of nodes)if(!counted.has(el)){counted.add(el);count++}}}if(count)await browser.runtime.sendMessage({type:"recordCosmetic",count}).catch(()=>{});if(!observer){observer=new MutationObserver(schedule);if(document.documentElement)observer.observe(document.documentElement,{childList:true,subtree:true})}}catch{}}
if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",schedule,{once:true});else schedule();
