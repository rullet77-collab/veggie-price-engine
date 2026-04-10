import { supabase } from '@/lib/supabase'

type CountResult = {
  products: number
  purchases: number
  sales: number
}

async function getDBStats(): Promise<CountResult> {
  const [products, purchases, sales] = await Promise.all([
    supabase.from('products').select('*', { count: 'exact', head: true }),
    supabase.from('daily_purchase_prices').select('*', { count: 'exact', head: true }),
    supabase.from('daily_selling_prices').select('*', { count: 'exact', head: true }),
  ])
  return {
    products: products.count ?? 0,
    purchases: purchases.count ?? 0,
    sales: sales.count ?? 0,
  }
}

async function getCategoryStats() {
  const { data } = await supabase
    .from('products')
    .select('category_name')
  if (!data) return []
  const counts: Record<string, number> = {}
  data.forEach((row) => {
    const cat = row.category_name || '미분류'
    counts[cat] = (counts[cat] || 0) + 1
  })
  return Object.entries(counts)
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count)
}

export default async function Home() {
  const stats = await getDBStats()
  const categories = await getCategoryStats()

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white border-b border-gray-200 px-6 py-4">
        <h1 className="text-2xl font-bold text-gray-900">
          야채 판매가 자동책정 시스템
        </h1>
        <p className="text-sm text-gray-500 mt-1">
          Supabase + Next.js 대시보드
        </p>
      </header>

      <main className="max-w-6xl mx-auto px-6 py-8">
        {/* DB 연결 상태 */}
        <section className="mb-8">
          <h2 className="text-lg font-semibold text-gray-800 mb-4">DB 현황</h2>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <StatCard
              title="상품 마스터"
              value={stats.products.toLocaleString()}
              unit="개"
              color="blue"
            />
            <StatCard
              title="매입 데이터"
              value={stats.purchases.toLocaleString()}
              unit="건"
              color="green"
            />
            <StatCard
              title="매출 데이터"
              value={stats.sales.toLocaleString()}
              unit="건"
              color="purple"
            />
          </div>
        </section>

        {/* 품목 대분류 */}
        <section>
          <h2 className="text-lg font-semibold text-gray-800 mb-4">
            품목 대분류별 상품 수
          </h2>
          <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr>
                  <th className="text-left px-4 py-3 font-medium text-gray-600">대분류</th>
                  <th className="text-right px-4 py-3 font-medium text-gray-600">상품 수</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-600">비율</th>
                </tr>
              </thead>
              <tbody>
                {categories.map((cat) => (
                  <tr key={cat.name} className="border-b border-gray-100 hover:bg-gray-50">
                    <td className="px-4 py-2 text-gray-900">{cat.name}</td>
                    <td className="px-4 py-2 text-right text-gray-700">{cat.count}</td>
                    <td className="px-4 py-2">
                      <div className="flex items-center gap-2">
                        <div className="h-2 bg-blue-500 rounded-full"
                          style={{ width: `${(cat.count / stats.products) * 100}%`, maxWidth: '200px' }}
                        />
                        <span className="text-gray-500 text-xs">
                          {((cat.count / stats.products) * 100).toFixed(1)}%
                        </span>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </main>
    </div>
  )
}

function StatCard({ title, value, unit, color }: {
  title: string; value: string; unit: string; color: 'blue' | 'green' | 'purple'
}) {
  const colorMap = {
    blue: 'bg-blue-50 border-blue-200 text-blue-700',
    green: 'bg-green-50 border-green-200 text-green-700',
    purple: 'bg-purple-50 border-purple-200 text-purple-700',
  }
  return (
    <div className={`rounded-lg border p-5 ${colorMap[color]}`}>
      <p className="text-sm font-medium opacity-80">{title}</p>
      <p className="text-3xl font-bold mt-1">
        {value} <span className="text-lg font-normal">{unit}</span>
      </p>
    </div>
  )
}
