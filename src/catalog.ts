// Static catalog: the products/SKUs we watch and the GTA-area Apple Stores.

export interface Sku {
  part: string;
  capacity: string;
  colorKey: string;
  colorDisplay: string;
}

export interface Product {
  id: string;
  name: string;
  shopUrl: string;
  skus: Sku[];
}

export interface Store {
  id: string;
  name: string;
  city: string;
}

export const PRODUCTS: Product[] = [
  {
    id: "iphone-duo",
    name: "iPhone Duo",
    shopUrl: "https://www.apple.com/ca/shop/buy-iphone/iphone-duo",
    skus: [
      {
        part: "MK244VC/A",
        capacity: "256GB",
        colorKey: "starwhite",
        colorDisplay: "Star White",
      },
      {
        part: "MK254VC/A",
        capacity: "256GB",
        colorKey: "nightsky",
        colorDisplay: "Night Sky",
      },
      {
        part: "MK264VC/A",
        capacity: "512GB",
        colorKey: "starwhite",
        colorDisplay: "Star White",
      },
      {
        part: "MK274VC/A",
        capacity: "512GB",
        colorKey: "nightsky",
        colorDisplay: "Night Sky",
      },
      {
        part: "MK284VC/A",
        capacity: "1TB",
        colorKey: "starwhite",
        colorDisplay: "Star White",
      },
      {
        part: "MK294VC/A",
        capacity: "1TB",
        colorKey: "nightsky",
        colorDisplay: "Night Sky",
      },
      {
        part: "MK2A4VC/A",
        capacity: "2TB",
        colorKey: "starwhite",
        colorDisplay: "Star White",
      },
      {
        part: "MK2C4VC/A",
        capacity: "2TB",
        colorKey: "nightsky",
        colorDisplay: "Night Sky",
      },
    ],
  },
];

export const STORES: Store[] = [
  { id: "R121", name: "Eaton Centre", city: "Toronto" },
  { id: "R120", name: "Yorkdale", city: "Toronto" },
  { id: "R208", name: "Sherway Gardens", city: "Toronto" },
  { id: "R333", name: "Fairview", city: "Toronto" },
  { id: "R350", name: "Square One", city: "Mississauga" },
  { id: "R515", name: "Markville", city: "Markham" },
  { id: "R447", name: "Mapleview Centre", city: "Burlington" },
  { id: "R429", name: "Upper Canada Mall", city: "Newmarket" },
  { id: "R464", name: "Conestoga", city: "Waterloo" },
];

export const ALL_SKUS: Sku[] = PRODUCTS.flatMap((p) => p.skus);

/** Look up a SKU (and its product) by Apple part number. */
export function findSku(
  part: string,
): { product: Product; sku: Sku } | undefined {
  for (const product of PRODUCTS) {
    const sku = product.skus.find((s) => s.part === part);
    if (sku) return { product, sku };
  }
  return undefined;
}

export function findStore(id: string): Store | undefined {
  return STORES.find((s) => s.id === id);
}

/** Human label such as "iPhone Duo 1TB Night Sky"; falls back to the part number. */
export function skuLabel(part: string): string {
  const found = findSku(part);
  if (!found) return part;
  return `${found.product.name} ${found.sku.capacity} ${found.sku.colorDisplay}`;
}
