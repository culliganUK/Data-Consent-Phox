// app/routes/app.customers.jsx
import { json } from "@remix-run/node";
import { useEffect, useMemo, useRef, useState } from "react";
import { useFetcher, useLoaderData, useNavigate, useSearchParams } from "@remix-run/react";
import { authenticate } from "~/shopify.server";
import { prisma } from "~/db.server";
import {
  Page, Card, Box, IndexTable, useIndexResourceState, Text, Badge, InlineStack,
  IndexFilters, ChoiceList, useSetIndexFiltersMode, useBreakpoints,
} from "@shopify/polaris";

const PAGE_SIZE = 50;

// Map DB state → UI label + Polaris badge tone
function getStateLabelTone(state) {
  switch (state) {
    case "SUBSCRIBED":
      return { label: "Subscribed", tone: "success" };
    case "UNSUBSCRIBED":
      return { label: "Unsubscribed", tone: "attention" };
    case "NOT_SUBSCRIBED":
      return { label: "Not subscribed", tone: "" };
    default:
      return { label: "—", tone: undefined };
  }
}

function parseParams(request) {
  const url = new URL(request.url);
  const q = (url.searchParams.get("q") || "").trim();
  let state = (url.searchParams.get("state") || "").trim().toUpperCase();
  if (!["SUBSCRIBED","UNSUBSCRIBED","NOT_SUBSCRIBED"].includes(state)) state = "";
  const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10));
  return { q, state, page };
}

function buildWhere({ shop, q, state }) {
  const whereAND = [];
  if (shop) whereAND.push({ shop });
  if (q) {
    whereAND.push({
      OR: [
        { email: { contains: q } },
        { firstName: { contains: q } },
        { lastName: { contains: q } },
      ],
    });
  }

  // Subscribed vs Not subscribed (UNSUBSCRIBED + NOT_SUBSCRIBED)
  if (state === "SUBSCRIBED") {
    whereAND.push({ lastState: "SUBSCRIBED" });
  } else if (state === "UNSUBSCRIBED" || state === "NOT_SUBSCRIBED") {
    whereAND.push({ lastState: { in: ["UNSUBSCRIBED", "NOT_SUBSCRIBED"] } });
  }

  return whereAND.length ? { AND: whereAND } : {};
}

export async function loader({ request }) {
  const { session } = await authenticate.admin(request);
  const shop = session?.shop;

  const { q, state, page } = parseParams(request);
  const where = buildWhere({ shop, q, state });

  const [total, rows] = await Promise.all([
    prisma.customer.count({ where }),
    prisma.customer.findMany({
      where,
      orderBy: [{ lastConsentAt: "desc" }, { id: "asc" }],
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      select: {
        id: true,
        shop: true,
        firstName: true,
        lastName: true,
        email: true,
        shopifyCustomerId: true,
        lastState: true,
        lastConsentAt: true,
      },
    }),
  ]);

  return json({
    q,
    state,
    page,
    initialData: { rows, total, page, pageSize: PAGE_SIZE },
  });
}

export default function CustomersIndex() {
  const { q, state, page, initialData } = useLoaderData();
  const [searchParams, setSearchParams] = useSearchParams();
  const { mode, setMode } = useSetIndexFiltersMode();
  const navigate = useNavigate();
  const fetcher = useFetcher();
  const breakpoints = useBreakpoints();
  const mounted = useRef(false);

  // UI state
  const [queryValue, setQueryValue] = useState(q);
  const [statusFilter, setStatusFilter] = useState(state ? [state] : []);
  const [pageState, setPageState] = useState(page);

  useEffect(() => {
    if (queryValue) {
      setMode("FILTERING"); // show filters on initial load if any params
    }
  });

  // Tabs (2 visible buckets; "Not subscribed" = UNSUBSCRIBED + NOT_SUBSCRIBED)
  const tabs = useMemo(
    () => [
      { content: "All customers", id: "all", index: 0 },
      { content: "Subscribed", id: "subscribed", index: 1 },
      { content: "Not subscribed", id: "not_subscribed", index: 2 },
    ],
    []
  );

  // ✅ Map NOT_SUBSCRIBED to the "Not subscribed" tab as well
  const tabIndexFromState = (st) =>
    st === "SUBSCRIBED" ? 1 : (st === "UNSUBSCRIBED" || st === "NOT_SUBSCRIBED") ? 2 : 0;

  const [selectedTab, setSelectedTab] = useState(tabIndexFromState(state || ""));

  const handleTabSelect = (i) => {
    setSelectedTab(i);
    if (i === 1) setStatusFilter(["SUBSCRIBED"]);
    else if (i === 2) setStatusFilter(["NOT_SUBSCRIBED"]); // sentinel for the "Not subscribed" group
    else setStatusFilter([]);
    setPageState(1);
    if (mounted.current) loadViaApi(1);
  };

  // Keep tab in sync with filter (when changed by filter UI)
  useEffect(() => {
    const st = statusFilter[0] || "";
    setSelectedTab(tabIndexFromState(st));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusFilter.join("|")]);

  // Build URLSearchParams (omit page when page === 1)
  const buildParams = (overrides = {}) => {
    const qv = overrides.queryValue ?? queryValue;
    const st = overrides.statusFilter ?? statusFilter;
    const pg = overrides.page ?? pageState;

    const sp = new URLSearchParams();
    if (qv) sp.set("q", qv);
    if (st[0]) sp.set("state", st[0]);
    if (pg !== 1) sp.set("page", String(pg));
    return sp;
  };

  const loadViaApi = (nextPage = pageState) => {
    const sp = buildParams({ page: nextPage });
    const qs = sp.toString();
    const url = qs ? `/app/api/customers?${qs}` : `/app/api/customers`;

    if (searchParams.toString() !== sp.toString()) {
      setSearchParams(sp, { replace: true });
    }
    setTimeout(() => fetcher.load(url), 0);
  };

  useEffect(() => { mounted.current = true; }, []);

  const [isFetching, setIsFetching] = useState(false);
  useEffect(() => {
    if (!mounted.current) return;
    setIsFetching(fetcher.state === "loading" || fetcher.state === "submitting");
  }, [fetcher.state]);

  // Debounced search
  useEffect(() => {
    if (!mounted.current) return;
    const t = setTimeout(() => { setPageState(1); loadViaApi(1); }, 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryValue]);

  // Filter change → immediate
  useEffect(() => {
    if (!mounted.current) return;
    setPageState(1);
    loadViaApi(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusFilter.join("|")]);

  const apiData = fetcher.data;
  const { rows, total, page: currentPage, pageSize } =
    apiData && typeof apiData === "object" ? apiData : initialData;

  const hasPrevious = currentPage > 1;
  const hasNext = currentPage * pageSize < total;

  const { selectedResources, allResourcesSelected, handleSelectionChange } =
    useIndexResourceState(rows, { resourceIDResolver: (i) => i.id });

  const resourceName = useMemo(() => ({ singular: "customer", plural: "customers" }), []);

  const filters = [
    {
      key: "status",
      label: "Email subscription",
      shortcut: true,
      filter: (
        <ChoiceList
          title="Email subscription"
          titleHidden
          choices={[
            { label: "Subscribed", value: "SUBSCRIBED" },
            // Use UNSUBSCRIBED as the value → backend treats it as the "Not subscribed" group
            { label: "Not subscribed", value: "NOT_SUBSCRIBED" },
          ]}
          selected={statusFilter}
          onChange={setStatusFilter}
          allowMultiple={false}
        />
      ),
    },
  ];

  const appliedFilters = [];
  if (statusFilter[0]) {
    appliedFilters.push({
      key: "status",
      label: statusFilter[0] === "SUBSCRIBED" ? "Subscribed" : "Not subscribed",
      onRemove: () => setStatusFilter([]),
    });
  }

  return (
    <Page title="Customers">
      <Box paddingBlockEnd={800}>
        <Card padding="0">
          <IndexFilters
            tabs={tabs}
            selected={selectedTab}
            onSelect={handleTabSelect}
            mode={mode}
            setMode={setMode}
            queryValue={queryValue}
            queryPlaceholder="Search by name or email"
            onQueryChange={setQueryValue}
            onQueryClear={() => setQueryValue("")}
            filters={filters}
            appliedFilters={appliedFilters}
            onClearAll={() => {
              setQueryValue("");
              setStatusFilter([]);
              setPageState(1);
              loadViaApi(1);
            }}
            canCreateNewView={false}
            loading={isFetching}
            cancelAction={{ onAction: () => {}, disabled: true, loading: false }}
          />

          <IndexTable
            condensed={breakpoints.smDown}
            resourceName={resourceName}
            itemCount={rows.length}
            selectedItemsCount={allResourcesSelected ? "All" : selectedResources.length}
            onSelectionChange={handleSelectionChange}
            headings={[
              { title: "Name" },
              { title: "Email" },
              { title: "Email subscription" },
              { title: "Last updated" },
            ]}
            selectable={false}
            loading={isFetching}
            pagination={{
              hasPrevious,
              hasNext,
              onPrevious: () => {
                if (!hasPrevious) return;
                const next = currentPage - 1;
                setPageState(next);
                loadViaApi(next);
              },
              onNext: () => {
                if (!hasNext) return;
                const next = currentPage + 1;
                setPageState(next);
                loadViaApi(next);
              },
            }}
          >
            {rows.map((c, index) => {
              const displayName = [c.firstName, c.lastName].filter(Boolean).join(" ") || "";
              const { label: stateLabel, tone: stateTone } = getStateLabelTone(c.lastState);

              return (
                <IndexTable.Row
                  id={c.id}
                  key={c.id}
                  position={index}
                  selected={selectedResources.includes(c.id)}
                  onClick={() => navigate(`/app/customers/${c.id}`)}
                >
                  <IndexTable.Cell>
                    <Text as="span" variant="bodyMd" fontWeight="medium">
                      {displayName}
                    </Text>
                  </IndexTable.Cell>
                  <IndexTable.Cell>
                    <InlineStack align="start" blockAlign="center" gap="200">
                      <Text as="span" variant="bodyMd">{c.email}</Text>
                    </InlineStack>
                  </IndexTable.Cell>
                  <IndexTable.Cell>
                    <Badge tone={stateTone}>{stateLabel}</Badge>
                  </IndexTable.Cell>
                  <IndexTable.Cell>
                    <Text tone="subdued">
                      {c.lastConsentAt ? new Date(c.lastConsentAt).toLocaleString() : ""}
                    </Text>
                  </IndexTable.Cell>
                </IndexTable.Row>
              );
            })}
          </IndexTable>
        </Card>
      </Box>
    </Page>
  );
}
