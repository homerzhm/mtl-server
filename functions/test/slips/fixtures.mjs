export const id = '11111111-1111-4111-8111-111111111111';
export const productId = '22222222-2222-4222-8222-222222222222';
export const secondProductId = '33333333-3333-4333-8333-333333333333';
export const catalog = [
  {id: productId, name: 'Roast Pork 12 lb', chineseName: '燒豬'},
  {id: secondProductId, name: 'Roast Chicken', chineseName: null},
];
export const unknown = () => ({value:null, confidence:'unknown', sourceLineIds:[]});
const field = (value, id) => ({value, confidence:'high', sourceLineIds:[id]});

export function preview() {
  return {
    version:1,
    sources:[
      {id:'pork',text:'2 × Roast Pork 12 lb'},
      {id:'chicken',text:'Roast Chicken'},
      {id:'date',text:'Dec 6 at 3'},
      {id:'pay',text:'PAY $20'},
      {id:'contact',text:'Test order 416-555-0100'},
    ],
    prefill: {
      items:[
        {productId:field(productId,'pork'),quantity:field(2,'pork')},
        {productId:field(secondProductId,'chicken'),quantity:{...unknown(),sourceLineIds:['chicken']}},
      ],
      pickup:{year:unknown(),month:field(12,'date'),day:field(6,'date'),hour:field(3,'date'),minute:unknown(),meridiem:unknown()},
      contactName:field('Test order','contact'),
      contactPhoneNumber:field('416-555-0100','contact'),
      notes:unknown(),
      depositReceivedCents:field(2000,'pay'),
    },
    paperAmounts:{totalCents:unknown(),payCents:field(2000,'pay'),balanceCents:unknown()},
  };
}

export function provider(raw = preview()) {
  return {start() {
    let round = 0;
    return {async turn({final}) {
      if (final) return {calls:[], final:raw};
      if (round++) return {calls:[]};
      return {calls:[
        {name:'searchActiveCatalog',args:{query:'Roast Pork 12 lb'}},
        {name:'searchActiveCatalog',args:{query:'Roast Chicken'}},
      ]};
    }};
  }};
}
