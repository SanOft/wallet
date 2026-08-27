import { useDispatch, useSelector } from "react-redux"
import type { AppDispatch, RootState } from "./store.js"

/**
 * Typed once so no component reaches for `any`.
 *
 * `useDispatch` and `useSelector` are generic over a store they cannot know
 * about, so every untyped call site either annotates itself or quietly widens.
 */
export const useAppDispatch = useDispatch.withTypes<AppDispatch>()
export const useAppSelector = useSelector.withTypes<RootState>()
