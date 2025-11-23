import { useShow, useList, IResourceComponentsProps } from "@refinedev/core";
import { Show, BreadcrumbProps, EditButton, RefreshButton } from "@refinedev/antd";
import { Button, Collapse, Table, Breadcrumb, message } from "antd";
import { PrinterOutlined, HomeOutlined, FileExcelOutlined } from "@ant-design/icons";
import { useRef, useState } from "react";
import { useReactToPrint } from "react-to-print";
import { Link } from "react-router-dom";
import { downloadOrderExcel } from "../../utils/excel/generateOrderExcel";
import { generateOrderFileName } from "../../utils/excel/fileNameGenerator";
import { handleExcelError } from "../../utils/excel/excelErrorHandler";
import { OrderPrintView } from "./components/print/OrderPrintView";
import { OrderShowHeader } from "./components/sections/OrderShowHeader";
import { OrderDatesBlock } from "./components/sections/OrderDatesBlock";
import { OrderFinanceBlock } from "./components/sections/OrderFinanceBlock";
import { OrderProductionBlock } from "./components/sections/OrderProductionBlock";
import { OrderFilesBlock } from "./components/sections/OrderFilesBlock";
import { OrderMetaBlock } from "./components/sections/OrderMetaBlock";

const { Panel } = Collapse;



export const OrderShow: React.FC<IResourceComponentsProps> = () => {
  const { queryResult } = useShow({
    meta: { 
      idColumnName: "order_id",
      fields: [
        "order_id",
        "order_name",
        "client_name",
        "order_date",
        "planned_completion_date",
        "completion_date",
        "issue_date",
        "payment_date",
        "total_amount",
        "discounted_amount",
        "discount",
        "paid_amount",
        "priority",
        "order_status_name",
        "payment_status_name",
        "manager_id",
        "milling_type_name",
        "edge_type_name",
        "film_name",
        "notes",
        "parts_count",
        "total_area",
        "link_cutting_file",
        "link_cutting_image_file",
        "link_cad_file",
        "link_pdf_file",
        "ref_key_1c",
        "version",
        "delete_flag",
        "created_at",
        "updated_at",
        "created_by",
        "edited_by",
      ],
    },
  });
  const { data, isLoading } = queryResult;

  const record = data?.data;

  // Загрузка деталей заказа
  const { data: detailsData, isLoading: detailsLoading } = useList({
    resource: "order_details",
    filters: [
      {
        field: "order_id",
        operator: "eq",
        value: record?.order_id,
      },
    ],
    pagination: { pageSize: 1000 },
    queryOptions: {
      enabled: !!record?.order_id,
    },
  });

  const details = (detailsData?.data || []).sort((a, b) => (a.detail_number || 0) - (b.detail_number || 0));

  // Загрузка справочников для отображения названий
  const { data: millingTypesData } = useList({
    resource: "milling_types",
    pagination: { pageSize: 10000 },
  });

  const { data: edgeTypesData } = useList({
    resource: "edge_types",
    pagination: { pageSize: 10000 },
  });

  const { data: filmsData } = useList({
    resource: "films",
    pagination: { pageSize: 10000 },
    filters: [],  // Убираем любые фильтры чтобы загрузить все записи
  });

  const { data: materialsData } = useList({
    resource: "materials",
    pagination: { pageSize: 10000 },
  });

  // Создаем lookup maps для быстрого поиска
  const millingTypesMap = new Map(
    (millingTypesData?.data || []).map((item: any) => [item.milling_type_id, item.milling_type_name])
  );
  const edgeTypesMap = new Map(
    (edgeTypesData?.data || []).map((item: any) => [item.edge_type_id, item.edge_type_name])
  );
  const filmsMap = new Map(
    (filmsData?.data || []).map((item: any) => [item.film_id, item.film_name])
  );
  const materialsMap = new Map(
    (materialsData?.data || []).map((item: any) => [item.material_id, item.material_name])
  );

  // Ref для печати
  const printRef = useRef<HTMLDivElement>(null);

  // Состояние для экспорта
  const [isExporting, setIsExporting] = useState(false);

  // Функция печати
  const handlePrint = useReactToPrint({
    contentRef: printRef,
    documentTitle: `Заказ-${record?.order_id}`,
  });

  // Функция экспорта в Excel
  const handleExportExcel = async () => {
    if (!record) return;

    setIsExporting(true);
    try {
      // Формат файла: заказ-Ф<ГГ>-<ID>-<название>-<клиент>.xlsx
      const fileName = generateOrderFileName({
        orderId: record.order_id,
        orderName: record.order_name,
        orderDate: record.order_date,
        clientName: record.client_name,
      });

      // Генерация и скачивание Excel
      await downloadOrderExcel(
        {
          order: {
            order_id: record.order_id,
            order_name: record.order_name,
            order_date: record.order_date,
            total_amount: record.total_amount,
            discounted_amount: record.discounted_amount,
            paid_amount: record.paid_amount,
            client: record.client_name ? { client_name: record.client_name } : null,
          },
          details: details.map(detail => ({
            detail_id: detail.detail_id,
            length: detail.height, // ⚠️ В БД height = длина детали
            width: detail.width,
            quantity: detail.quantity,
            area: detail.area,
            milling_cost_per_sqm: detail.milling_cost_per_sqm,
            detail_cost: detail.detail_cost,
            notes: detail.note,
            milling_type: { milling_type_name: millingTypesMap.get(detail.milling_type_id) || '' },
            edge_type: { edge_type_name: edgeTypesMap.get(detail.edge_type_id) || '' },
            film: { film_name: filmsMap.get(detail.film_id) || '' },
            material: { material_name: materialsMap.get(detail.material_id) || '' },
          })),
          client: record.client_name ? { client_name: record.client_name } : null,
        },
        fileName
      );

      message.success('Excel файл успешно сгенерирован');
    } catch (error) {
      const errorMessage = handleExcelError(error);
      message.error(errorMessage);
      console.error('Ошибка экспорта:', error);
    } finally {
      setIsExporting(false);
    }
  };

  return (
    <Show
      isLoading={isLoading || detailsLoading}
      title="Просмотр заказа"
      breadcrumb={
        <Breadcrumb>
          <Breadcrumb.Item>
            <Link to="/">
              <HomeOutlined />
            </Link>
          </Breadcrumb.Item>
          <Breadcrumb.Item>
            <Link to="/orders">Заказы</Link>
          </Breadcrumb.Item>
          <Breadcrumb.Item>Просмотр</Breadcrumb.Item>
        </Breadcrumb>
      }
      headerButtons={() => (
        <>
          <EditButton>Изменить</EditButton>
          <RefreshButton>Обновить</RefreshButton>
          <Button
            type="primary"
            icon={<PrinterOutlined />}
            onClick={handlePrint}
            disabled={!record || details.length === 0}
          >
            Печать
          </Button>
          <Button
            icon={<FileExcelOutlined />}
            onClick={handleExportExcel}
            loading={isExporting}
            disabled={!record || details.length === 0}
          >
            Экспорт в Excel
          </Button>
        </>
      )}
    >
      {record && (
        <>
          {/* Компактная шапка заказа (Read-only summary) */}
          <div style={{ marginBottom: 4 }}>
            <OrderShowHeader record={record} details={details} />
          </div>
          
          {/* Финансы */}
          <Collapse defaultActiveKey={[]} style={{ marginBottom: 4 }}>
            <Panel 
              header={<span style={{ fontSize: 14, fontWeight: 600, color: '#faad14' }}>Финансы</span>} 
              key="finance"
            >
              <OrderFinanceBlock record={record} />
            </Panel>
          </Collapse>
          
          {/* Дополнительная информация - схлопнутый блок */}
          <Collapse defaultActiveKey={[]} style={{ marginBottom: 16 }}>
            <Panel 
              header={<span style={{ fontSize: 14, fontWeight: 600 }}>Дополнительная информация</span>} 
              key="additional"
            >
              {/* Даты */}
              <div style={{ marginBottom: 16 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: '#52c41a', marginBottom: 8 }}>
                  Даты
                </div>
                <OrderDatesBlock record={record} />
              </div>
              
              {/* Производство */}
              <div style={{ marginBottom: 16 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: '#fa8c16', marginBottom: 8 }}>
                  Производство
                </div>
                <OrderProductionBlock 
                  record={record} 
                  details={details}
                  millingTypesMap={millingTypesMap}
                  edgeTypesMap={edgeTypesMap}
                  filmsMap={filmsMap}
                />
              </div>
              
              {/* Файлы */}
              <div style={{ marginBottom: 16 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: '#722ed1', marginBottom: 8 }}>
                  Файлы
                </div>
                <OrderFilesBlock record={record} />
              </div>
              
              {/* Служебная информация */}
              <div>
                <div style={{ fontSize: 13, fontWeight: 600, color: '#8c8c8c', marginBottom: 8 }}>
                  Служебная информация
                </div>
                <OrderMetaBlock record={record} />
              </div>
            </Panel>
          </Collapse>

          {/* Детали заказа - компактная таблица */}
          <div style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 14, fontWeight: 600, color: '#1890ff', marginBottom: 8 }}>
              Детали заказа
            </div>
            <Table
              dataSource={details}
              rowKey="detail_id"
              size="small"
              pagination={false}
              bordered
              scroll={{ x: 'max-content' }}
              style={{ fontSize: 12 }}
              rowClassName={(_, index) => index % 2 === 0 ? 'table-row-light' : 'table-row-dark'}
              components={{
                header: {
                  cell: (props: any) => <th {...props} style={{ ...props.style, padding: '2px 4px' }} />
                },
                body: {
                  cell: (props: any) => <td {...props} style={{ ...props.style, padding: '2px 4px' }} />
                }
              }}
              columns={[
                {
                  title: '№',
                  dataIndex: 'detail_number',
                  key: 'detail_number',
                  width: 50,
                  align: 'center',
                },
                {
                  title: 'Высота',
                  dataIndex: 'height',
                  key: 'height',
                  width: 72,
                  align: 'center',
                },
                {
                  title: 'Ширина',
                  dataIndex: 'width',
                  key: 'width',
                  width: 72,
                  align: 'center',
                },
                {
                  title: 'Кол-во',
                  dataIndex: 'quantity',
                  key: 'quantity',
                  width: 63,
                  align: 'center',
                },
                {
                  title: 'м²',
                  dataIndex: 'area',
                  key: 'area',
                  width: 80,
                  align: 'center',
                  render: (value) => value ? value.toFixed(2) : '0.00',
                },
                {
                  title: 'Фрезеровка',
                  key: 'milling_type',
                  width: 128,
                  render: (_, record) => millingTypesMap.get(record.milling_type_id) || '—',
                },
                {
                  title: 'Обкат',
                  key: 'edge_type',
                  width: 50,
                  render: (_, record) => {
                    const edgeTypeName = edgeTypesMap.get(record.edge_type_id) || '—';
                    return <span style={{ fontSize: '0.86em' }}>{edgeTypeName}</span>;
                  },
                },
                {
                  title: 'Материал',
                  key: 'material',
                  width: 50,
                  render: (_, record) => {
                    const materialName = materialsMap.get(record.material_id) || '—';
                    return <span style={{ fontSize: '0.86em' }}>{materialName}</span>;
                  },
                },
                {
                  title: 'Примечание',
                  dataIndex: 'note',
                  key: 'note',
                  width: 162,
                  ellipsis: true,
                  render: (value) => value || '—',
                },
                {
                  title: 'Цена за кв.м.',
                  dataIndex: 'milling_cost_per_sqm',
                  key: 'milling_cost_per_sqm',
                  width: 70,
                  align: 'right',
                  render: (value) => (value !== null && value !== undefined) ? value.toLocaleString('ru-RU', { minimumFractionDigits: 0, maximumFractionDigits: 0 }) : '—',
                },
                {
                  title: 'Сумма',
                  dataIndex: 'detail_cost',
                  key: 'detail_cost',
                  width: 59,
                  align: 'right',
                  render: (value) => (value !== null && value !== undefined) ? value.toLocaleString('ru-RU', { minimumFractionDigits: 0, maximumFractionDigits: 0 }) : '—',
                },
                {
                  title: 'Пленка',
                  key: 'film',
                  width: 173,
                  render: (_, record) => {
                    if (!record.film_id) return '—';
                    const filmName = filmsMap.get(record.film_id);
                    return <span style={{ fontSize: '0.86em' }}>{filmName || '—'}</span>;
                  },
                },
              ]}
            />
          </div>

          {/* Скрытый компонент для печати */}
          <OrderPrintView
            ref={printRef}
            order={{
              order_id: record.order_id,
              order_name: record.order_name,
              order_date: record.order_date,
              total_amount: record.total_amount,
              discounted_amount: record.discounted_amount,
              paid_amount: record.paid_amount,
              parts_count: record.parts_count,
              total_area: record.total_area,
              notes: record.notes,
            }}
            details={details.map(detail => ({
              ...detail,
              milling_type: { milling_type_name: millingTypesMap.get(detail.milling_type_id) || '' },
              edge_type: { edge_type_name: edgeTypesMap.get(detail.edge_type_id) || '' },
              film: { film_name: filmsMap.get(detail.film_id) || '' },
            }))}
            client={record.client_name ? { client_name: record.client_name } : undefined}
          />
        </>
      )}
    </Show>
  );
};
