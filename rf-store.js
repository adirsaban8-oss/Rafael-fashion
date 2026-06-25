/* ============================================================
   Rafael Fashion — shared data store
   Local-first (localStorage). Firebase-ready: every read/write
   goes through this layer, so swapping to Firestore later only
   touches this file. Used by both index.html and admin.html.
   ============================================================ */
(function(global){
  'use strict';

  var K = {
    settings:  'rf_settings',
    overrides: 'rf_overrides',   // { productId: {price,salePrice,inStock,badge,outSizes:[],name_he,name_en,name_fr,desc_*} }
    custom:    'rf_custom',      // [ fullProductObject ... ]
    removed:   'rf_removed',     // [ productId ... ]
    images:    'rf_images',      // { variantKeyOrId: [urls] }
    covers:    'rf_covers',      // { 'cat/sub': url }
    orders:    'rf_orders',      // [ orderObject ... ]
    snapshot:  'rf_snapshot'     // catalog snapshot written by the site for the admin
  };

  function read(key, def){
    try { var v = localStorage.getItem(key); return v ? JSON.parse(v) : def; }
    catch(e){ return def; }
  }
  function write(key, val){
    try { localStorage.setItem(key, JSON.stringify(val)); return true; }
    catch(e){ console.warn('store write failed', key, e); return false; }
  }

  var DEFAULT_SETTINGS = {
    adminPass: '1234',
    whatsapp: '972546398638',
    currency: '₪',
    banner_he: 'משלוח חינם בקניית חליפה · ייעוץ אישי לאירועים · נתניה',
    banner_en: 'Free shipping with suit purchase · Personal consultation · Netanya',
    banner_fr: "Livraison gratuite à l'achat d'un costume · Consultation personnelle · Netanya",
    coupons: []  // [{code,type:'percent'|'fixed',value,active}]
  };

  var Store = {
    keys: K,

    /* ---------- settings ---------- */
    getSettings: function(){ return Object.assign({}, DEFAULT_SETTINGS, read(K.settings, {})); },
    saveSettings: function(obj){ write(K.settings, Object.assign(this.getSettings(), obj)); },

    /* ---------- per-product overrides ---------- */
    getOverrides: function(){ return read(K.overrides, {}); },
    getOverride: function(id){ return this.getOverrides()[id] || {}; },
    setOverride: function(id, patch){
      var all = this.getOverrides();
      all[id] = Object.assign({}, all[id], patch);
      write(K.overrides, all);
    },
    clearOverride: function(id){ var all = this.getOverrides(); delete all[id]; write(K.overrides, all); },

    /* ---------- custom (admin-created) products ---------- */
    getCustom: function(){ return read(K.custom, []); },
    saveCustom: function(prod){
      var all = this.getCustom();
      var i = all.findIndex(function(p){ return p.id === prod.id; });
      if(i>=0) all[i] = prod; else all.push(prod);
      write(K.custom, all);
    },
    deleteCustom: function(id){ write(K.custom, this.getCustom().filter(function(p){ return p.id!==id; })); },

    /* ---------- removed (hidden) base products ---------- */
    getRemoved: function(){ return read(K.removed, []); },
    isRemoved: function(id){ return this.getRemoved().indexOf(id) >= 0; },
    setRemoved: function(id, val){
      var all = this.getRemoved();
      var has = all.indexOf(id) >= 0;
      if(val && !has) all.push(id);
      if(!val && has) all = all.filter(function(x){ return x!==id; });
      write(K.removed, all);
    },

    /* ---------- image overrides ---------- */
    getImagesMap: function(){ return read(K.images, {}); },
    getImagesFor: function(key){ return this.getImagesMap()[key] || null; },
    setImagesFor: function(key, arr){
      var all = this.getImagesMap();
      if(arr && arr.length) all[key] = arr; else delete all[key];
      write(K.images, all);
    },

    /* ---------- cover overrides ---------- */
    getCoversMap: function(){ return read(K.covers, {}); },
    setCover: function(catSub, url){
      var all = this.getCoversMap();
      if(url) all[catSub] = url; else delete all[catSub];
      write(K.covers, all);
    },

    /* ---------- orders ---------- */
    getOrders: function(){ return read(K.orders, []); },
    addOrder: function(order){
      var all = this.getOrders();
      order.id = order.id || ('ORD-' + (Date.now().toString(36).toUpperCase()));
      order.status = order.status || 'new';
      all.unshift(order);
      write(K.orders, all);
      return order.id;
    },
    updateOrder: function(id, patch){
      var all = this.getOrders();
      var i = all.findIndex(function(o){ return o.id===id; });
      if(i>=0){ all[i] = Object.assign({}, all[i], patch); write(K.orders, all); }
    },
    deleteOrder: function(id){ write(K.orders, this.getOrders().filter(function(o){ return o.id!==id; })); },

    /* ---------- catalog snapshot (site -> admin bridge) ---------- */
    setSnapshot: function(cat){ write(K.snapshot, cat); },
    getSnapshot: function(){ return read(K.snapshot, []); },

    /* ---------- coupons ---------- */
    findCoupon: function(code){
      if(!code) return null;
      code = String(code).trim().toLowerCase();
      var c = (this.getSettings().coupons||[]).find(function(x){ return x.active && String(x.code).toLowerCase()===code; });
      return c || null;
    },

    /* ---------- apply overrides onto a base product object ---------- */
    applyToProduct: function(p){ return this.applyWithKey(p, p.id); },
    applyWithKey: function(p, key){
      var o = this.getOverride(key);
      if(!o || !Object.keys(o).length) return p;
      var m = Object.assign({}, p);
      if(o.price !== undefined && o.price !== '') m.price = (o.price===null? null : Number(o.price));
      if(o.salePrice !== undefined && o.salePrice !== '' && o.salePrice !== null) m.salePrice = Number(o.salePrice);
      if(o.inStock !== undefined) m.inStock = !!o.inStock;
      if(o.badge) m.badge = o.badge;                 // 'new' | 'bestseller' | 'featured'
      if(o.outSizes) m.outSizes = o.outSizes;        // sizes that are out of stock
      ['name','desc'].forEach(function(f){
        ['he','en','fr'].forEach(function(l){
          var k=f+'_'+l; if(o[k]!==undefined && o[k]!=='') m[k]=o[k];
        });
      });
      return m;
    },

    /* ---------- full backup / restore ---------- */
    exportAll: function(){
      var out = {};
      Object.keys(K).forEach(function(name){ out[name] = read(K[name], null); });
      out._exportedAt = new Date().toISOString();
      return out;
    },
    importAll: function(obj){
      Object.keys(K).forEach(function(name){
        if(obj[name] !== undefined && obj[name] !== null) write(K[name], obj[name]);
      });
    },
    wipe: function(){ Object.keys(K).forEach(function(name){ localStorage.removeItem(K[name]); }); }
  };

  global.RFStore = Store;
})(window);
