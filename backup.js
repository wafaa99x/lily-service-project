
/***********************
 * DELIVERY SYSTEM (FINAL STABLE)
 ***********************/

// ======================
// VARIANTS
// ======================
const DELIVERY_VARIANTS = {
  3: 46164475936965,
  5: 46164477182149,
  7: 46164478951621,
  10: 46164481343685
};

// ======================
// DATA
// ======================
const DELIVERY_DATA = {

  capital: {
    "الخالدية":3,"الدسمة":3,"الدعية":3,"الدوحة":3,"الروضة":3,"السرة":3,
    "الشامية":3,"الشرق":3,"الشويخ":3,"الصالحية":3,"الصليبيخات":3,"الصوابر":3,
    "العديلية":3,"الفيحاء":3,"القادسية":3,"القبلة":3,"المرقاب":3,"المنصورية":3,
    "النزهة":3,"النهضة":3,"اليرموك":3,"برج الحمراء":3,"بنيد القار":3,
    "جابر الأحمد":3,"شمال غرب الصليبيخات":3,"عبدالله السالم":3,
    "غرناطة":3,"قرطبة":3,"كيفان":3,"مدينة الكويت":3
  },

  ahmadi: {
    "علي صباح السالم - أم الهيمان":7,
    "صباح الأحمد 1":7,"صباح الأحمد 2":7,"صباح الأحمد 3":7,
    "صباح الأحمد 4":7,"صباح الأحمد 5":7,"صباح الأحمد 6":7,
    "الخيران":10,"الوفرة":10,
    "أبو حليفة":3,"الرقة":3,"الصباحية":3,"الظهر":3,"العقيلة":3,
    "الفحيحيل":3,"الفنطاس":3,"المنقف":3,"المهبولة":3,
    "جابر العلي":3,"الأحمدي":3,"فهد الأحمد":3,"هدية":3
  },

  jahra: {
    "المطلاع":5,"جنوب المطلاع":5,
    "المطلاع N01":5,"المطلاع N02":5,"المطلاع N03":5,"المطلاع N04":5,
    "المطلاع N05":5,"المطلاع N06":5,"المطلاع N07":5,"المطلاع N08":5,
    "المطلاع N09":5,"المطلاع N10":5,"المطلاع N11":5,"المطلاع N12":5,
    "الصبية":10,"العبدلي":10,"السالمي":10,
    "الجهراء":3,"الصليبية":3,"العيون":3,"القصر":3,"القيروان":3,
    "النسيم":3,"النعيم":3,"الواحة":3,"تيماء":3,"سعد العبدالله":3,
    "جنوب الجهراء":3,"صليبية السكنية":3
  },

  farwaniya: {
    "الهجن":5,"كبد":5,
    "خيطان":3,"إشبيليا":3,"الأندلس":3,"الرابية":3,"الرحاب":3,
    "الرقعي":3,"الري":3,"الشدادية":3,"الضجيج":3,"العارضية":3,
    "العمرية":3,"الفردوس":3,"الفروانية":3,"المطار":3,
    "جليب الشيوخ":3,"جنوب عبدالله المبارك":3,
    "صباح الناصر":3,"عبدالله المبارك":3,"غرب عبدالله المبارك":3
  },

  hawalli: {
    "البدع":3,"الجابرية":3,"الرميثية":3,"الزهراء":3,"السالمية":3,
    "السلام":3,"الشعب":3,"الشهداء":3,"الصديق":3,"بيان":3,
    "حطين":3,"حولي":3,"سلوى":3,"مبارك العبدالله":3,
    "مشرف":3,"ميدان حولي":3
  },

  mubarak: {
    "أبو الحصانية":3,"أبو فطيرة":3,"أسواق القرين":3,"العدّان":3,
    "الفنيطيس":3,"القرين":3,"القصور":3,"المسائل":3,
    "المسيلة":3,"صباح السالم":3,"غرب أبو فطيرة الحرفية":3,
    "مبارك الكبير":3,"وسطى":3
  }
};

// ======================
// INIT
// ======================
document.addEventListener("DOMContentLoaded", init);
document.addEventListener("DOMContentLoaded", async function () {

  const cart = await fetch('/cart.js').then(r => r.json());

  const hasDelivery = cart.items.some(item =>
    item.product_title.toLowerCase().includes("delivery")
  );

  if (hasDelivery) {
    populateFromStorage();
  }

});
document.addEventListener("cart:refresh", init);

function init() {


  updateUI();
}

// ======================
// SINGLE CHANGE HANDLER (MERGED)
// ======================
document.addEventListener("change", async function(e){

  // GOVERNORATE
  if(e.target.id === "gov"){
    populateAreas(e.target.value);
  }

  // AREA
  if(e.target.id === "area"){

    const gov = document.getElementById("gov").value;
    const area = e.target.value;

    if(!gov || !area) return;

    localStorage.setItem("tempGov", gov);
    localStorage.setItem("tempArea", area);

    const price = DELIVERY_DATA[gov][area];
    const variantId = DELIVERY_VARIANTS[price];

    await forceSingleDelivery(variantId);
  }

});

// ======================
// POPULATE AREAS
// ======================
function populateAreas(gov){
  const areaEl = document.getElementById("area");
  areaEl.innerHTML = '<option value="">Select Area</option>';

  if(!DELIVERY_DATA[gov]) return;

  Object.keys(DELIVERY_DATA[gov]).forEach(area=>{
    const price = DELIVERY_DATA[gov][area];

    const opt = document.createElement("option");
    opt.value = area;
    opt.textContent = `${area} - ${price} KWD`;
    areaEl.appendChild(opt);
  });
}

// ======================
// CONFIRM BUTTON
// ======================
document.addEventListener("click", function(e){

  if(e.target.id !== "confirm-area") return;

  const gov = localStorage.getItem("tempGov");
  const area = localStorage.getItem("tempArea");

  if(!gov || !area){
    alert("Select delivery area first");
    return;
  }

  localStorage.setItem("selectedGov", gov);
  localStorage.setItem("selectedArea", area);

  updateUI();

});
{% comment %} LOADER FOR CONFIRM BUTTON {% endcomment %}
document.getElementById("confirm-area").addEventListener("click", function () {

  const btn = this;

  // 🔥 1. show loading state
  btn.disabled = true;
  const originalText = btn.innerText;
  btn.innerText = "Loading...";

  // optional: add spinner style hook
  btn.classList.add("loading");

  // 🔥 2. your logic here (example)
  // save area / cart logic etc...

  // 🔥 3. reload after delay
  setTimeout(() => {
    location.reload();
  }, 3000);

});
// ======================
// FORCE DELIVERY (FIXED)
// ======================
async function forceSingleDelivery(variantId){

  const cart = await fetch('/cart.js').then(r=>r.json());

  let updates = {};

  cart.items.forEach(item=>{
    if(item.product_title.toLowerCase().includes("delivery")){
      updates[item.variant_id] = 0;
    }
  });

  if(Object.keys(updates).length){
    await fetch('/cart/update.js',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({updates})
    });

    await new Promise(res => setTimeout(res, 200));
  }

  await fetch('/cart/add.js',{
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({id:variantId,quantity:1})
  });

  setTimeout(() => {
    document.dispatchEvent(new CustomEvent("cart:refresh"));
  }, 300);
}

// ======================
// UI UPDATE
// ======================
async function updateUI(){

  const box = document.getElementById("delivery-summary");
  if(!box) return;

  const gov = localStorage.getItem("selectedGov");
  const area = localStorage.getItem("selectedArea");

  if(!gov || !area){
    box.style.display = "none";
    return;
  }

  const cart = await fetch('/cart.js').then(r=>r.json());

  const item = cart.items.find(i =>
    i.product_title.toLowerCase().includes("delivery")
  );

  if(!item){
    box.style.display = "none";
    return;
  }

  document.getElementById("delivery-area-name").innerText =
    "Selected Area: " + area;

  document.getElementById("delivery-fee-line").innerText =
    "Delivery Fee: " + (item.final_line_price/100).toFixed(2) + " KWD";

  box.style.display = "block";
}

// ======================
// RESTORE
// ======================
function populateFromStorage(){

  const gov = localStorage.getItem("selectedGov");
  const area = localStorage.getItem("selectedArea");

  if(!gov) return;

  document.getElementById("gov").value = gov;
  populateAreas(gov);

  setTimeout(()=>{
    document.getElementById("area").value = area || "";
  },150);
}
  updateUI();
(function () {
  const originalFetch = window.fetch;

  window.fetch = async function (...args) {
    const response = await originalFetch.apply(this, args);

    const url = args[0];

    if (typeof url === "string" && url.includes("/cart/change")) {
      setTimeout(() => {
        updateUI();   // <-- your function
      }, 250);
    }

    return response;
  };
})();
