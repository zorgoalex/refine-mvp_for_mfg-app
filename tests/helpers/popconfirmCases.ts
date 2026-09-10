import { readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

// Read actual page JSX so checks cannot pass against a copied compatibility example.
export const popconfirmCases = [
  { name: 'Bazis project', file: 'src/pages/bazis/BazisPage.tsx', index: 0, title: 'Удалить Базис-проект?', description: '«Тест» и все его ревизии будут удалены безвозвратно.' },
  { name: 'Bazis cut set', file: 'src/pages/bazis-cut/BazisCutListPage.tsx', index: 0, title: 'Удалить пустой набор?', description: '«Тест» будет удалён безвозвратно.' },
  { name: 'export template', file: 'src/pages/configuration/components/ExportTemplatesConfigTab.tsx', index: 0, title: 'Удалить шаблон?', description: 'Это действие скроет шаблон из экспорта.' },
  { name: 'status automation', file: 'src/pages/configuration/components/StatusAutomationConfig.tsx', index: 0, title: 'Обновить автостатусы', description: 'Будут проверены заказы за последние два месяца. Правила событий МДФ-доски пропускаются: для них нужна исходная карточка.' },
  { name: 'VLM model', file: 'src/pages/configuration/components/VlmModelsSection.tsx', index: 0, title: 'Удалить модель?', description: '"Тест" будет удалена' },
  { name: 'VLM prompt', file: 'src/pages/configuration/components/VlmPromptsSection.tsx', index: 0, title: 'Удалить промпт?', description: '"Тест" будет удалён' },
  { name: 'VLM provider', file: 'src/pages/configuration/components/VlmProvidersSection.tsx', index: 0, title: 'Удалить провайдера?', description: '"Тест" будет удалён вместе со всеми моделями' },
  { name: 'order full toolbar', file: 'src/pages/orders/components/OrderForm.tsx', index: 0, title: 'Удалить заказ №Тест?', description: 'Заказ попадёт в корзину, его можно будет восстановить.' },
  { name: 'order compact toolbar', file: 'src/pages/orders/components/OrderForm.tsx', index: 1, title: 'Удалить заказ №Тест?', description: 'Заказ попадёт в корзину, его можно будет восстановить.' },
  { name: 'Telegram unlink', file: 'src/pages/profile/TelegramNotificationsCard.tsx', index: 0, title: 'Отключить Telegram?', description: 'Новые уведомления по правилам Telegram приходить не будут.' },
] as const;

export function readPopconfirmAttributes(file: string, index: number): Record<string, string> {
  const source = ts.createSourceFile(file, readFileSync(path.resolve(file), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const matches: Record<string, string>[] = [];
  function visit(node: ts.Node) {
    if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && node.tagName.getText(source) === 'Popconfirm') {
      const props: Record<string, string> = {};
      for (const attribute of node.attributes.properties) {
        if (!ts.isJsxAttribute(attribute)) throw new Error(`${file}: unexpected spread on Popconfirm`);
        const initializer = attribute.initializer;
        props[attribute.name.getText(source)] = initializer && ts.isJsxExpression(initializer)
          ? initializer.expression?.getText(source) ?? 'undefined'
          : initializer?.getText(source) ?? 'true';
      }
      matches.push(props);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  if (!matches[index]) throw new Error(`${file}: missing Popconfirm #${index}`);
  return matches[index];
}
