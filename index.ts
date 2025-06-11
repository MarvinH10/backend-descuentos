import express, { Request, Response } from 'express';
import axios from 'axios';
import cors from 'cors';
import dotenv from 'dotenv';

dotenv.config();
const app = express();
app.use(cors());
app.use(express.json());

const ODOO_URL = process.env.ODOO_URL as string;
const DB = process.env.ODOO_DB as string;
const USER = process.env.ODOO_USER as string;
const PASSWORD = process.env.ODOO_PASSWORD as string;

let uid: number | null = null;

interface BarcodeRequest { 
  barcode: string; 
}

interface PricelistRule {
  id?: number;
  min_quantity: number;
  fixed_price?: number;
  percent_price?: number;
  compute_price?: string;
  pricelist_id?: [number, string];
  product_name?: string;
  applied_on?: string;
  categ_id?: [number, string] | false;
  product_tmpl_id?: [number, string] | false;
  product_id?: [number, string] | false;
}

interface RulesByApplication {
  global: PricelistRule[];
  category: PricelistRule[];
  product_template: PricelistRule[];
  product_variant: PricelistRule[];
}

async function login() {
  const resp = await axios.post(ODOO_URL, {
    jsonrpc: '2.0',
    method: 'call',
    id: Date.now(),
    params: {
      service: 'common',
      method: 'login',
      args: [DB, USER, PASSWORD]
    }
  });
  uid = resp.data.result;
}

app.get('/', (_req, res) => {
  res.send('🟢 Middleware Odoo en línea');
});

async function getActivePricelists(): Promise<number[]> {
  if (!uid) await login();
  const resp = await axios.post(ODOO_URL, {
    jsonrpc: '2.0',
    method: 'call',
    id: Date.now(),
    params: {
      service: 'object',
      method: 'execute_kw',
      args: [
        DB,
        uid,
        PASSWORD,
        'product.pricelist',
        'search_read',
        [[['x_studio_disponible', '=', true]]],
        { fields: ['id'] }
      ]
    }
  });
  return (resp.data.result as Array<{ id: number }>).map(pl => pl.id);
}

async function getAllApplicableRules(productId: number, templateId: number, categoryId?: number): Promise<PricelistRule[]> {
  if (!uid) await login();
  
  const activePricelistIds = await getActivePricelists();
  
  let conditions: any[] = [
    ['pricelist_id', 'in', activePricelistIds],
    '|', '|', '|',
    ['applied_on', '=', '3_global'],
    '&', ['applied_on', '=', '2_product_category'],
         categoryId ? ['categ_id', '=', categoryId] : ['categ_id', '!=', false],
    '&', ['applied_on', '=', '1_product'],
         ['product_tmpl_id', '=', templateId],
    '&', ['applied_on', '=', '0_product_variant'],
         ['product_id', '=', productId]
  ];

  const rulesResp = await axios.post(ODOO_URL, {
    jsonrpc: '2.0',
    method: 'call',
    id: Date.now(),
    params: {
      service: 'object',
      method: 'execute_kw',
      args: [
        DB,
        uid,
        PASSWORD,
        'product.pricelist.item',
        'search_read',
        [conditions],
        {
          fields: [
            'min_quantity', 
            'fixed_price', 
            'percent_price', 
            'compute_price', 
            'pricelist_id',
            'applied_on',
            'categ_id',
            'product_tmpl_id',
            'product_id'
          ]
        }
      ]
    }
  });

  return rulesResp.data.result as PricelistRule[];
}

function separateRulesByApplication(rules: PricelistRule[], productId: number, templateId: number, categoryId?: number): RulesByApplication {
  const separated: RulesByApplication = {
    global: [],
    category: [],
    product_template: [],
    product_variant: []
  };

  rules.forEach(rule => {
    switch (rule.applied_on) {
      case '3_global':
        separated.global.push(rule);
        break;
      case '2_product_category':
        if (categoryId && rule.categ_id && rule.categ_id[0] === categoryId) {
          separated.category.push(rule);
        }
        break;
      case '1_product':
        if (rule.product_tmpl_id && rule.product_tmpl_id[0] === templateId) {
          separated.product_template.push(rule);
        }
        break;
      case '0_product_variant':
        if (rule.product_id && rule.product_id[0] === productId) {
          separated.product_variant.push(rule);
        }
        break;
    }
  });

  return separated;
}

async function getProductCategory(templateId: number): Promise<number | null> {
  if (!uid) await login();
  
  const resp = await axios.post(ODOO_URL, {
    jsonrpc: '2.0',
    method: 'call',
    id: Date.now(),
    params: {
      service: 'object',
      method: 'execute_kw',
      args: [
        DB,
        uid,
        PASSWORD,
        'product.template',
        'search_read',
        [[['id', '=', templateId]]],
        { fields: ['categ_id'] }
      ]
    }
  });

  const templates = resp.data.result;
  if (Array.isArray(templates) && templates.length > 0) {
    const categoryId = templates[0].categ_id;
    return Array.isArray(categoryId) ? categoryId[0] : null;
  }
  return null;
}

app.post(
  '/product-by-barcode',
  async (req: Request<{}, {}, BarcodeRequest>, res: Response): Promise<void> => {
    try {
      const { barcode } = req.body;
      if (!uid) await login();

      const prodResp = await axios.post(ODOO_URL, {
        jsonrpc: '2.0',
        method: 'call',
        id: Date.now(),
        params: {
          service: 'object',
          method: 'execute_kw',
          args: [
            DB,
            uid,
            PASSWORD,
            'product.product',
            'search_read',
            [[['barcode', '=', barcode]]],
            { fields: ['id', 'name', 'product_template_variant_value_ids', 'lst_price', 'product_tmpl_id'] }
          ]
        }
      });

      const prods = prodResp.data.result;
      if (!Array.isArray(prods) || prods.length === 0) {
        res.status(404).json({ success: false, error: 'Producto no encontrado' });
        return;
      }
      
      const product = prods[0];
      const productId = product.id;
      const templateId = product.product_tmpl_id[0];
      
      const categoryId = await getProductCategory(templateId);
      
      const allRules = await getAllApplicableRules(productId, templateId, categoryId || undefined);
      
      const rulesByApplication = separateRulesByApplication(allRules, productId, templateId, categoryId || undefined);

      const variantNames = Array.isArray(product.product_template_variant_value_ids)
        ? product.product_template_variant_value_ids.map((v: any) => v.name).join(' ')
        : '';
      
      const productName = variantNames 
        ? `${product.name} ${variantNames}`
        : product.name;

      Object.keys(rulesByApplication).forEach(key => {
        rulesByApplication[key as keyof RulesByApplication] = rulesByApplication[key as keyof RulesByApplication].map(rule => ({
          ...rule,
          product_name: productName
        }));
      });

      res.json({
        success: true,
        barcode,
        product_name: productName,
        lst_price: product.lst_price,
        rules_by_application: rulesByApplication,
        total_rules: allRules.length
      });
    } catch (err) {
      console.error(err);
      res.status(500).json({ success: false, error: 'Error buscando producto y reglas' });
    }
  }
);

app.get(
  '/product-by-barcode/:barcode',
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { barcode } = req.params;
      if (!uid) await login();

      const prodResp = await axios.post(ODOO_URL, {
        jsonrpc: '2.0',
        method: 'call',
        id: Date.now(),
        params: {
          service: 'object',
          method: 'execute_kw',
          args: [
            DB,
            uid,
            PASSWORD,
            'product.product',
            'search_read',
            [[['barcode', '=', barcode]]],
            { fields: ['id', 'name', 'lst_price', 'product_template_variant_value_ids', 'product_tmpl_id'] }
          ]
        }
      });

      const prods = prodResp.data.result;
      if (!Array.isArray(prods) || prods.length === 0) {
        res.status(404).json({ success: false, error: 'Producto no encontrado' });
        return;
      }
      
      const product = prods[0];
      const productId = product.id;
      const templateId = product.product_tmpl_id[0];
      
      const categoryId = await getProductCategory(templateId);
      
      const allRules = await getAllApplicableRules(productId, templateId, categoryId || undefined);
      
      const rulesByApplication = separateRulesByApplication(allRules, productId, templateId, categoryId || undefined);

      const variantNames = Array.isArray(product.product_template_variant_value_ids)
        ? product.product_template_variant_value_ids.map((v: any) => v.name).join(' ')
        : '';
      
      const productName = variantNames 
        ? `${product.name} ${variantNames}`
        : product.name;

      Object.keys(rulesByApplication).forEach(key => {
        rulesByApplication[key as keyof RulesByApplication] = rulesByApplication[key as keyof RulesByApplication].map(rule => ({
          ...rule,
          product_name: productName
        }));
      });

      res.json({
        success: true,
        barcode,
        product_name: productName,
        lst_price: product.lst_price,
        rules_by_application: rulesByApplication,
        total_rules: allRules.length
      });
    } catch (err) {
      console.error(err);
      res.status(500).json({ success: false, error: 'Error buscando producto y reglas' });
    }
  }
);

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`🟢 Middleware en http://localhost:${PORT}`);
});