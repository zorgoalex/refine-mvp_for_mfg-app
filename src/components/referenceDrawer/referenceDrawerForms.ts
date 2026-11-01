// Формы справочников, которые NewLine открывает в боковой панели (те же компоненты, что на страницах
// /<справочник>/edit/:id и /create). Грузятся лениво — только когда панель открыта. Справочника здесь нет —
// «Изменить» и «Добавить» ведут на страницы, как раньше. Намеренно не здесь: «Цеха заказа» (запись — команда
// backend, в Hasura только чтение), «Сотрудники», «Плёнки», «Поставщики», «Производители» (контакты, поставщики, контрагент 1С
// сохраняются отдельными блоками — список их сам не перечитает), пользователи, листовые материалы, клиенты, заказы, платежи.
import { lazy, type ComponentType, type LazyExoticComponent } from 'react';

type Page = LazyExoticComponent<ComponentType<Record<string, never>>>;

const page = (loader: () => Promise<Record<string, unknown>>, name: string): Page =>
  lazy(async () => ({ default: (await loader())[name] as ComponentType<Record<string, never>> }));

export interface ReferenceDrawerPages {
  edit: Page;
  create: Page;
}

export const REFERENCE_DRAWER_FORMS: Record<string, ReferenceDrawerPages> = {
  edge_types: { edit: page(() => import('../../pages/edge_types/edit'), 'EdgeTypeEdit'), create: page(() => import('../../pages/edge_types/create'), 'EdgeTypeCreate') },
  film_types: { edit: page(() => import('../../pages/film_types/edit'), 'FilmTypeEdit'), create: page(() => import('../../pages/film_types/create'), 'FilmTypeCreate') },
  material_transaction_types: { edit: page(() => import('../../pages/material_transaction_types/edit'), 'MaterialTransactionTypeEdit'), create: page(() => import('../../pages/material_transaction_types/create'), 'MaterialTransactionTypeCreate') },
  material_types: { edit: page(() => import('../../pages/material_types/edit'), 'MaterialTypeEdit'), create: page(() => import('../../pages/material_types/create'), 'MaterialTypeCreate') },
  materials: { edit: page(() => import('../../pages/materials/edit'), 'MaterialEdit'), create: page(() => import('../../pages/materials/create'), 'MaterialCreate') },
  milling_types: { edit: page(() => import('../../pages/milling_types/edit'), 'MillingTypeEdit'), create: page(() => import('../../pages/milling_types/create'), 'MillingTypeCreate') },
  movements_statuses: { edit: page(() => import('../../pages/movements_statuses/edit'), 'MovementStatusEdit'), create: page(() => import('../../pages/movements_statuses/create'), 'MovementStatusCreate') },
  order_statuses: { edit: page(() => import('../../pages/order_statuses/edit'), 'OrderStatusEdit'), create: page(() => import('../../pages/order_statuses/create'), 'OrderStatusCreate') },
  payment_statuses: { edit: page(() => import('../../pages/payment_statuses/edit'), 'PaymentStatusEdit'), create: page(() => import('../../pages/payment_statuses/create'), 'PaymentStatusCreate') },
  payment_types: { edit: page(() => import('../../pages/payment_types/edit'), 'PaymentTypeEdit'), create: page(() => import('../../pages/payment_types/create'), 'PaymentTypeCreate') },
  production_statuses: { edit: page(() => import('../../pages/production_statuses/edit'), 'ProductionStatusEdit'), create: page(() => import('../../pages/production_statuses/create'), 'ProductionStatusCreate') },
  requisition_statuses: { edit: page(() => import('../../pages/requisition_statuses/edit'), 'RequisitionStatusEdit'), create: page(() => import('../../pages/requisition_statuses/create'), 'RequisitionStatusCreate') },
  resource_requirements_statuses: { edit: page(() => import('../../pages/resource_requirements_statuses/edit'), 'ResourceRequirementStatusEdit'), create: page(() => import('../../pages/resource_requirements_statuses/create'), 'ResourceRequirementStatusCreate') },
  transaction_direction: { edit: page(() => import('../../pages/transaction_direction/edit'), 'TransactionDirectionEdit'), create: page(() => import('../../pages/transaction_direction/create'), 'TransactionDirectionCreate') },
  units: { edit: page(() => import('../../pages/units/edit'), 'UnitEdit'), create: page(() => import('../../pages/units/create'), 'UnitCreate') },
  work_centers: { edit: page(() => import('../../pages/work_centers/edit'), 'WorkCenterEdit'), create: page(() => import('../../pages/work_centers/create'), 'WorkCenterCreate') },
  workshops: { edit: page(() => import('../../pages/workshops/edit'), 'WorkshopEdit'), create: page(() => import('../../pages/workshops/create'), 'WorkshopCreate') },
};
