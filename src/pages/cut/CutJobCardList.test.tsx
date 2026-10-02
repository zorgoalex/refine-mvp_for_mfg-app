import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ColumnsType } from 'antd/es/table';
import { CutJobCardList } from './CutJobCardList';

vi.mock('./cutJobCardList.css', () => ({}));
vi.mock('antd', () => ({
  Select: (props: any) => React.createElement('select-stub', props),
  Spin: () => React.createElement('spin-stub'),
}));

interface Job { cutJobId: number; name: string; createdAt: string; details: number; }

const jobs: Job[] = [
  { cutJobId: 1, name: 'Первое', createdAt: '2026-09-01', details: 5 },
  { cutJobId: 2, name: 'Второе', createdAt: '2026-09-03', details: 9 },
  { cutJobId: 3, name: 'Третье', createdAt: '2026-09-02', details: 1 },
];
const onDelete = vi.fn();
const columns: ColumnsType<Job> = [
  { title: '#', dataIndex: 'cutJobId', key: 'id', render: (_: unknown, row) => `#${row.cutJobId}` },
  { title: 'Дата', dataIndex: 'createdAt', key: 'createdAt', sorter: (a, b) => a.createdAt.localeCompare(b.createdAt) },
  { title: 'Название', dataIndex: 'name', key: 'name' },
  { title: 'Деталей', key: 'details', sorter: (a, b) => a.details - b.details, render: (_: unknown, row) => row.details },
  { title: 'Новая колонка', key: 'somethingNew', render: (_: unknown, row) => `extra-${row.cutJobId}` },
  {
    title: 'Действия',
    key: 'actions',
    render: (_: unknown, row) => React.createElement('button', { type: 'button', onClick: () => onDelete(row.cutJobId) }, 'Удалить'),
  },
];

let renderer: ReactTestRenderer;
const mount = (props: Partial<React.ComponentProps<typeof CutJobCardList<Job>>> = {}) => {
  act(() => {
    renderer = create(
      <CutJobCardList<Job> jobs={jobs} columns={columns} emptyText="Нет раскроев" onOpen={() => undefined} {...props} />,
    );
  });
};
const cards = () => renderer.root.findAll((node) => node.type === 'article');
const names = () => cards().map((card) => card.findByProps({ className: 'wb-cut-job__name' }).children.join(''));

afterEach(() => {
  act(() => renderer?.unmount());
  onDelete.mockReset();
});

describe('CutJobCardList', () => {
  it('draws one card per job from the table column renderers, including actions and unknown columns', () => {
    mount({ activeJobId: 2 });

    expect(cards()).toHaveLength(3);
    const text = JSON.stringify(renderer.toJSON());
    for (const expected of ['#1', 'Первое', 'Детали', 'Новая колонка', 'extra-3', 'Удалить']) {
      expect(text).toContain(expected);
    }
    expect(cards().map((card) => card.props['data-active'])).toEqual([false, true, false]);

    act(() => {
      cards()[2].findByType('button').props.onClick();
    });
    expect(onDelete).toHaveBeenCalledWith(3);
  });

  it('keeps the sorting the table headers offered', () => {
    mount();
    const select = renderer.root.findByType('select-stub' as never);
    expect(select.props.options.map((option: { value: string }) => option.value)).toEqual([
      'default', 'createdAt:descend', 'createdAt:ascend', 'details:descend', 'details:ascend',
    ]);
    expect(names()).toEqual(['Первое', 'Второе', 'Третье']);

    act(() => select.props.onChange('details:descend'));
    expect(names()).toEqual(['Второе', 'Первое', 'Третье']);

    act(() => select.props.onChange('createdAt:ascend'));
    expect(names()).toEqual(['Первое', 'Третье', 'Второе']);
  });

  it('opens a job by a click on the card but not on its buttons, and shows the empty and loading states', () => {
    const onOpen = vi.fn();
    mount({ onOpen });
    act(() => cards()[1].props.onClick({ target: { closest: () => ({}) } }));
    expect(onOpen).not.toHaveBeenCalled();
    act(() => cards()[1].props.onClick({ target: { closest: () => null } }));
    expect(onOpen).toHaveBeenCalledWith(jobs[1]);

    act(() => renderer.update(<CutJobCardList<Job> jobs={[]} columns={columns} emptyText="Нет раскроев" onOpen={onOpen} />));
    expect(JSON.stringify(renderer.toJSON())).toContain('Нет раскроев');

    act(() => renderer.update(<CutJobCardList<Job> jobs={[]} columns={columns} emptyText="Нет раскроев" loading onOpen={onOpen} />));
    expect(renderer.root.findAllByType('spin-stub' as never)).toHaveLength(1);
  });
});
