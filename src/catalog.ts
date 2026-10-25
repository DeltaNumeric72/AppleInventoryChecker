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
  address: string;
  phone: string;
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
  {
    id: "R121",
    name: "Eaton Centre",
    city: "Toronto",
    address: "220 Yonge Street, Toronto, M5B 2H1",
    phone: "647-258-0801",
  },
  {
    id: "R120",
    name: "Yorkdale",
    city: "Toronto",
    address: "3401 Dufferin Street, Toronto, M6A 3A1",
    phone: "416-785-1776",
  },
  {
    id: "R208",
    name: "Sherway Gardens",
    city: "Toronto",
    address: "25 The West Mall, Toronto, M9C 1B8",
    phone: "416-646-8489",
  },
  {
    id: "R333",
    name: "Fairview",
    city: "Toronto",
    address: "1800 Sheppard Avenue East, Toronto, M2J 5A7",
    phone: "416-646-4412",
  },
  {
    id: "R350",
    name: "Square One",
    city: "Mississauga",
    address: "100 City Centre Drive, Mississauga, L5B 2C9",
    phone: "905-366-0580",
  },
  {
    id: "R515",
    name: "Markville",
    city: "Markham",
    address: "5000 Highway 7 East, Markham, L3R 4M9",
    phone: "905-513-2860",
  },
  {
    id: "R429",
    name: "Upper Canada Mall",
    city: "Newmarket",
    address: "17600 Yonge Street, Newmarket, L3Y 4Z1",
    phone: "905-952-3400",
  },
  {
    id: "R447",
    name: "Mapleview Centre",
    city: "Burlington",
    address: "900 Maple Avenue, Burlington, L7S 2J8",
    phone: "289-288-2012",
  },
  {
    id: "R464",
    name: "Conestoga",
    city: "Waterloo",
    address: "550 King Street North, Waterloo, N2L 5W6",
    phone: "519-772-5150",
  },
  {
    id: "R489",
    name: "Masonville",
    city: "London",
    address: "1680 Richmond Street North, London, N6G 3Y9",
    phone: "519-963-4060",
  },
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

/** Colours in display order. */
export const COLORS: { key: string; display: string }[] = [
  { key: "nightsky", display: "Night Sky" },
  { key: "starwhite", display: "Star White" },
];

/** Capacities in display order. */
export const CAPACITIES: string[] = ["256GB", "512GB", "1TB", "2TB"];

/** The SKU for a colour key and capacity, if one exists. */
export function skuFor(colorKey: string, capacity: string): Sku | undefined {
  return ALL_SKUS.find((s) =>
    s.colorKey === colorKey && s.capacity === capacity
  );
}

/** Short label such as "Night Sky 256GB"; falls back to the part number. */
export function shortLabel(part: string): string {
  const found = findSku(part);
  if (!found) return part;
  return `${found.sku.colorDisplay} ${found.sku.capacity}`;
}
